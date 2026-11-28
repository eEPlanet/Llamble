# Remote Access → Other addresses: shows once HTTPS is ready, adds, saves, removes
import sys, json, requests
from playwright.sync_api import sync_playwright
B = sys.argv[1]
s = requests.post(B + "/api/setup", json={"username": "boss", "password": "master-pass1", "server_name": "Town"}).json()
M = s["token"]; H = {"Authorization": "Bearer " + M}
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(viewport={"width": 1280, "height": 900})
    def fake(route):  # the real certificate can't be fetched here; pretend it's ready
        if route.request.method != "GET": return route.continue_()
        d = requests.get(B + "/api/admin/remote", headers=H).json()
        d.update(enabled=True, mode="direct", domain="chat.example.com"); d["status"].update(tls_state="ready", ddns_state="ok", ddns_ip="203.0.113.7", ddns_at=0)
        route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    pg.route("**/api/admin/remote", fake)
    pg.goto(B + "/"); pg.evaluate(f"localStorage.setItem('llamble.token', '{M}')"); pg.goto(B + "/"); pg.wait_for_timeout(2500)
    pg.locator("button[title='User Settings']").first.click(); pg.wait_for_timeout(500)
    pg.locator(".settings-nav >> text=Remote Access").first.click(); pg.wait_for_timeout(800)
    box = pg.locator(".other-addrs"); box.wait_for(timeout=5000)
    pg.locator("button:has-text('Add address')").click()
    row = box.locator(".other-row").first
    row.locator("input").nth(0).fill("store.example.com"); row.locator("input").nth(1).fill("store:8100")
    pg.screenshot(path="/tmp/other-addrs.png", full_page=False)
    box.locator("button:has-text('Save')").click(); pg.wait_for_timeout(1200)
    got = requests.get(B + "/api/admin/remote", headers=H).json()["other"]
    assert got == [{"name": "store.example.com", "to": "store:8100"}], got
    assert not box.locator("button:has-text('Save')").count()  # nothing unsaved now
    box.locator("button:has-text('Remove')").click(); box.locator("button:has-text('Save')").click(); pg.wait_for_timeout(1200)
    assert requests.get(B + "/api/admin/remote", headers=H).json()["other"] == []
    br.close()
print("OTHER ADDRESSES UI OK")
