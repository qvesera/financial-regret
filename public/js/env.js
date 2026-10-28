/**
 * Deploy-time configuration -- written by scripts/gen_env.sh, do not edit.
 *
 * Left empty in the repo so the default stays "same origin": server.py serves
 * public/ and /api from one process, so there is nothing to point at. A public
 * split deploy (static site on a CDN, API elsewhere) rewrites this line from
 * BACKEND_URL at build time.
 *
 * This file holds a URL only. Never put a key here: the bundle ships to
 * everyone, and it is not a secret store.
 */
export const API_BASE = "";
