import { useState } from "react";
import { Lock } from "lucide-react";
import { Field, Notice, TextInput } from "./AgentUi";
import { invoke } from "../lib/tauri";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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
    <main className="flex min-h-full items-center justify-center overflow-auto bg-background p-4">
      <Card className="w-full max-w-[460px] p-6">
        <CardHeader className="justify-items-center text-center">
          <img src="/favicon.svg" alt="" className="size-10" />
          <CardTitle className="text-xl">Vantyr Agent</CardTitle>
          <CardDescription>Sign in to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-center text-sm text-muted-foreground">
            Enter the UI access password for this agent.
          </p>
          <form className="mt-4 flex flex-col gap-4" onSubmit={handleSubmit}>
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
            <Button
              variant="default"
              disabled={checking || !pw}
              type="submit"
            >
              <Lock size={16} aria-hidden="true" />
              {checking ? "Checking…" : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
