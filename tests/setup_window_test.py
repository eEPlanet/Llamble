# Setup (making the master admin) is only open for a few minutes after the server starts.
# Run with LLAMBLE_SETUP_MINUTES=0 to check it's refused once closed; the normal suites check
# it works while open.
import sys, requests
B = sys.argv[1]
i = requests.get(B + "/api/info").json()
assert i["setup_required"] and i["setup_left_s"] == 0, i
r = requests.post(B + "/api/setup", json={"username": "late", "password": "pass-word-123"})
assert r.status_code == 403 and "Restart" in r.text, (r.status_code, r.text)
assert requests.get(B + "/api/info").json()["setup_required"], "still not set up"
print("SETUP WINDOW OK: closed setup is refused with restart instructions")
