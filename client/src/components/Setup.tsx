import { useEffect, useState } from "react";
import { openModal } from "../ui";
import { api, setSession } from "../api";
import { useStore } from "../store";
import { ModelPicker } from "./ModelPicker";

/** First-run wizard: shown when the server has no accounts yet. */
// shown once the admin finishes setup
let recoveryCode = "";

export function Setup({ server, onDone, onCancel }: { server: string; onDone: (token: string) => void; onCancel?: () => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [username, setUsername] = useState("");
  const [display, setDisplay] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [serverName, setServerName] = useState("");
  const [token, setToken] = useState("");
  const [guildId, setGuildId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // setup is only open for a few minutes after the server starts (so nobody can take over a
  // forgotten install); this counts down, and says what to do once it has closed
  const [closesAt, setClosesAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    api("/api/info", { server, token: null })
      .then((i) => typeof i.setup_left_s === "number" && setClosesAt(Date.now() + i.setup_left_s * 1000))
      .catch(() => {});
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [server]);
  const left = closesAt === null ? null : Math.max(0, Math.round((closesAt - now) / 1000));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const device = window.llambleNative ? `Llamble Desktop (${window.llambleNative.platform})` : "Browser";
      const r = await api("/api/setup", {
        server,
        token: null,
        body: { username, password, display_name: display || undefined, server_name: serverName || undefined, device_name: device },
      });
      setToken(r.token);
      setGuildId(r.guild_id);
      recoveryCode = r.recovery_code || "";
      setStep(2);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => {
    if (guildId) {
      // open the new server first
      localStorage.setItem("llamble.lastGuild", guildId);
      useStore.setState({ selectedGuild: guildId });
    }
    setSession(server, token);
    onDone(token);
    if (recoveryCode) setTimeout(() => openModal({ kind: "recoveryCode", code: recoveryCode }), 800);
  };

  return (
    <div className="login-bg">
      <div className="titlebar-drag" />
      {step === 1 ? (
        <form className="login-card" onSubmit={create}>
          <div className="setup-steps">
            <span className="on">1. Admin account</span>
            <span>2. AI model</span>
          </div>
          <img className="login-logo" src="./logo-banner.jpg" alt="Llamble" />
          <h1>Set up your Llamble server</h1>
          <p className="muted">
            This server has no accounts yet. The account you create here is the <b>owner/admin</b>.
          </p>
          <div className="muted small center">{server}</div>
          {left === 0 ? (
            <div className="form-error">
              Setup closed for safety. Restart your Llamble server (the Restart button where you installed it), then come back and finish setup within 10 minutes.
            </div>
          ) : left !== null && left < 600 ? (
            <div className="muted small center">
              For safety, setup closes in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}. Restarting the server opens it again.
            </div>
          ) : null}
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
          </label>
          <label>
            Display name <span className="muted">(optional)</span>
            <input value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          </label>
          <label>
            Name your first server <span className="muted">(optional — e.g. your company name)</span>
            <input value={serverName} onChange={(e) => setServerName(e.target.value)} placeholder="My Clients" />
          </label>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary wide" disabled={busy || !username || password.length < 8}>
            {busy ? "Creating…" : "Create admin account"}
          </button>
          {onCancel && (
            <p className="small center">
              <a href="#" onClick={(e) => (e.preventDefault(), onCancel())}>
                Back
              </a>
            </p>
          )}
        </form>
      ) : (
        <div className="login-card wide-card">
          <div className="setup-steps">
            <span>1. Admin account ✓</span>
            <span className="on">2. AI model</span>
          </div>
          <h1>Pick the AI model</h1>
          <p className="muted">
            The bot runs this model on the server whenever nobody is lending a GPU. You can change it any time in Settings → Instance Admin → AI Model.
          </p>
          <ModelPicker opts={{ server, token }} compact />
          <div className="row gap" style={{ marginTop: 20 }}>
            <button className="btn" onClick={finish}>
              Skip for now
            </button>
            <div className="grow" />
            <button className="btn primary" onClick={finish}>
              Finish setup
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
