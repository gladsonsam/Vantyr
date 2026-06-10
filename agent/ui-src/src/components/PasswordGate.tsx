import { useState } from "react";
import { Lock } from "lucide-react";
import { Button, Field, Notice, TextInput } from "./AgentUi";
import { invoke } from "../lib/tauri";

export function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pw) return;
    setChecking(true);
    try {
      await invoke("verify_ui_password", { password: pw });
      setError(false);
      onUnlock();
    } catch {
      setError(true);
      setPw("");
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="vantyr-agent-auth-shell animate-fade-in">
      <section className="vantyr-agent-auth-card">
        <div className="vantyr-agent-auth-card-content">
          <div className="vantyr-agent-auth-card-brand">
            <img src="/favicon.svg" alt="" className="vantyr-agent-auth-logo" />
            <h1 className="vantyr-agent-auth-title">Vantyr Agent</h1>
            <p className="vantyr-agent-auth-subtitle">Sign in to continue</p>
          </div>

          <p className="vantyr-agent-auth-hint">Enter the UI access password for this agent.</p>

          <form className="agent-stack" onSubmit={handleSubmit}>
            {error ? (
              <Notice tone="error" title="Wrong password">
                Try again.
              </Notice>
            ) : null}
            <Field label="Password">
              <TextInput
                value={pw}
                onChange={(event) => setPw(event.currentTarget.value)}
                type="password"
                placeholder="Password"
                autoComplete="current-password"
                autoFocus
              />
            </Field>
            <Button variant="primary" disabled={checking || !pw} loading={checking} type="submit" icon={<Lock size={16} />}>
              Unlock
            </Button>
          </form>
        </div>
      </section>
    </main>
  );
}
