#!/usr/bin/env python3
"""Percent-encode stdin for use in postgresql:// URLs (supabase --db-url)."""
import sys
import urllib.parse

sys.stdout.write(urllib.parse.quote(sys.stdin.read(), safe=''))
