/**
 * Maps between a domain object, its persistence entity, and its DTO.
 */
export interface Mapper<TDomain, TEntity, TDTO = unknown> {
  toDomain(entity: TEntity): TDomain;
  toEntity(domain: TDomain): TEntity;
  toDTO(domain: TDomain): TDTO;
}
