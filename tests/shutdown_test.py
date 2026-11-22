# Stopping the server (an update): every app is told when to come back (spread out) and its
# connection is closed politely, so routers do not see a burst. Usage: shutdown_test.py URL SERVER_PID
import json, sys, threading, time, requests, subprocess, os, signal
from websocket import create_connection
B=sys.argv[1]; pid=int(sys.argv[2])
s=requests.post(B+"/api/setup",json={"username":"alex","password":"master-pass1","server_name":"F"}).json(); T=s["token"]
ws=create_connection(B.replace("http","ws")+"/api/gateway?access_token="+T); ws.recv()
got=[]
def listen():
    with requests.get(B+"/api/notify/stream",headers={"Authorization":"Bearer "+T},stream=True,timeout=30) as r:
        ev=None
        for line in r.iter_lines(decode_unicode=True):
            if line.startswith("event:"): ev=line[6:].strip()
            elif line.startswith("data:") and ev=="bye": got.append(json.loads(line[5:]))
        got.append("ended")
threading.Thread(target=listen,daemon=True).start(); time.sleep(0.5)
t0=time.time(); os.kill(pid,signal.SIGTERM)
while True:
    m=json.loads(ws.recv())
    if m["t"]=="RESTARTING": break
assert m["t"]=="RESTARTING" and 4000<=m["d"]["retry_in_ms"]<25000, m
try:
    ws.recv(); print("unexpected")
except Exception as e: pass
print("gateway: RESTARTING", m["d"], "then closed")
for _ in range(50):
    if "ended" in got: break
    time.sleep(0.1)
assert got and got[0]["retry_in_ms"]>=10000 and got[-1]=="ended", got
print("phone stream: bye", got[0], "then ended")
for _ in range(100):
    try: os.kill(pid,0); time.sleep(0.1)
    except OSError: break
print(f"server stopped after {time.time()-t0:.1f}s")
print("SHUTDOWN OK")
