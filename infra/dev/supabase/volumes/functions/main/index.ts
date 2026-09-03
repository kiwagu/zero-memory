import * as jose from 'https://deno.land/x/jose@v4.14.4/index.ts'

const log = {
  debug: (ctx: unknown, msg?: string) => console.debug('[edge_main]', msg ?? ctx, msg ? ctx : ''),
  info: (ctx: unknown, msg?: string) => console.info('[edge_main]', msg ?? ctx, msg ? ctx : ''),
  error: (ctx: unknown, msg?: string) => console.error('[edge_main]', msg ?? ctx, msg ? ctx : ''),
}
log.info('main function started')

const JWT_SECRET = Deno.env.get('JWT_SECRET')
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')
const VERIFY_JWT = Deno.env.get('VERIFY_JWT') === 'true'

// Create JWKS for ES256/RS256 tokens (newer tokens)
let SUPABASE_JWT_KEYS: ReturnType<typeof jose.createRemoteJWKSet> | null = null
if (SUPABASE_URL) {
  try {
    SUPABASE_JWT_KEYS = jose.createRemoteJWKSet(
      new URL('/auth/v1/.well-known/jwks.json', SUPABASE_URL)
    )
  } catch (e) {
    log.error({ detail: String(e) }, 'Failed to fetch JWKS from SUPABASE_URL')
  }
}

/**
 * Extract JWT token from Authorization header
 * 
 * Parses the Authorization header to extract the Bearer token.
 * Expects format: "Bearer <token>"
 * 
 * @param req - The HTTP request object
 * @returns The JWT token string
 * @throws Error if Authorization header is missing or malformed
 */
function getAuthToken(req: Request) {
  const authHeader = req.headers.get('authorization')
  if (!authHeader) {
    throw new Error('Missing authorization header')
  }
  const [bearer, token] = authHeader.split(' ')
  if (bearer !== 'Bearer') {
    throw new Error(`Auth header is not 'Bearer {token}'`)
  }
  return token
}

async function isValidLegacyJWT(jwt: string): Promise<boolean> {
  if (!JWT_SECRET) {
    log.error('JWT_SECRET not available for HS256 token verification')
    return false
  }

  const encoder = new TextEncoder();
  const secretKey = encoder.encode(JWT_SECRET)

  try {
    await jose.jwtVerify(jwt, secretKey);
  } catch (e) {
    log.error({ detail: String(e) }, 'Symmetric Legacy JWT verification error')
    return false;
  }
  return true;
}

async function isValidJWT(jwt: string): Promise<boolean> {
  if (!SUPABASE_JWT_KEYS) {
    log.error('JWKS not available for ES256/RS256 token verification')
    return false
  }

  try {
    await jose.jwtVerify(jwt, SUPABASE_JWT_KEYS)
  } catch (e) {
    log.error({ detail: String(e) }, 'Asymmetric JWT verification error')
    return false
  }

  return true;
}

/**
 * Verify JWT token, handling both legacy (HS256) and newer (ES256/RS256) algorithms
 * 
 * This function automatically detects the algorithm used in the token and applies
 * the appropriate verification method:
 * - HS256: Uses JWT_SECRET (symmetric key)
 * - ES256/RS256: Uses JWKS endpoint (asymmetric public keys)
 * 
 * This fix ensures compatibility with both legacy tokens and newer asymmetric tokens,
 * resolving the "Key for the ES256 algorithm must be of type CryptoKey" error.
 * 
 * @param jwt - The JWT token string to verify
 * @returns Promise resolving to true if verification succeeds, false otherwise
 */
async function isValidHybridJWT(jwt: string): Promise<boolean> {
  const { alg: jwtAlgorithm } = jose.decodeProtectedHeader(jwt)

  if (jwtAlgorithm === 'HS256') {
    log.debug(`Legacy token type detected, attempting ${jwtAlgorithm} verification`)

    return await isValidLegacyJWT(jwt)
  }

  if (jwtAlgorithm === 'ES256' || jwtAlgorithm === 'RS256') {
    return await isValidJWT(jwt)
  }

  return false;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'OPTIONS' && VERIFY_JWT) {
    try {
      const token = getAuthToken(req)
      const isValidJWT = await isValidHybridJWT(token);

      if (!isValidJWT) {
        return new Response(JSON.stringify({ msg: 'Invalid JWT' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
    } catch (e) {
      log.error({ detail: String(e) }, 'JWT gate error')
      return new Response(JSON.stringify({ msg: String(e) }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      })
    }
  }

  const url = new URL(req.url)
  const { pathname } = url
  const path_parts = pathname.split('/')
  const service_name = path_parts[1]

  if (!service_name || service_name === '') {
    const error = { msg: 'missing function name in request' }
    return new Response(JSON.stringify(error), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const servicePath = `/home/deno/functions/${service_name}`
  log.info({ servicePath }, 'serving the request')

  const memoryLimitMb = 150
  const workerTimeoutMs = 1 * 60 * 1000
  const noModuleCache = false
  const candidateImportMap = `${servicePath}/deno.json`
  let importMapPath: string | null = null
  try {
    const st = await Deno.stat(candidateImportMap)
    if (st.isFile) {
      importMapPath = candidateImportMap
    }
  } catch {
    // no per-function import map
  }
  const envVarsObj = Deno.env.toObject()
  const envVars = Object.keys(envVarsObj).map((k) => [k, envVarsObj[k]])

  try {
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath,
      memoryLimitMb,
      workerTimeoutMs,
      noModuleCache,
      importMapPath,
      envVars,
    })
    log.debug({ servicePath }, 'worker fetch start')
    const res = await worker.fetch(req)
    log.info({ servicePath, status: res.status }, 'worker fetch done')
    return res
  } catch (e) {
    log.error({ servicePath, detail: String(e) }, 'worker create/fetch failed')
    const error = { msg: String(e) }
    return new Response(JSON.stringify(error), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
