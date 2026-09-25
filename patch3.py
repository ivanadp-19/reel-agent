import pathlib
p = pathlib.Path('/home/aiagent/railway-app/server/index.mjs')
s = p.read_text()
old = """  const url = new URL(req.url, 'http://localhost');
  if (PUBLIC_MODE) {"""
new = """  const url = new URL(req.url, 'http://localhost');
  if (PUBLIC_MODE && url.pathname === '/api/ping') return json(res, 200, {ok: true}); // Railway healthcheck: no auth, no info
  if (PUBLIC_MODE) {"""
assert old in s
s = s.replace(old, new, 1)
p.write_text(s)
t = pathlib.Path('/home/aiagent/railway-app/railway.toml')
c = t.read_text().replace('healthcheckPath = "/api/health"', 'healthcheckPath = "/api/ping"')
t.write_text(c)
print('patch3 ok')
