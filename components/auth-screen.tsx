"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Mail,
  ShieldCheck,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/primitives";

function homeForRole(role: string | null | undefined) {
  return role === "admin" || role === "manager" ? "/admin" : "/dashboard";
}

async function applyInviteSessionFromUrl() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : "";
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  if (!accessToken || !refreshToken) return;
  const supabase = createClient();
  await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${window.location.search}`,
  );
}

async function redirectHome(
  supabase: ReturnType<typeof createClient>,
  options?: { welcome?: boolean },
) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    window.location.replace("/login");
    return;
  }
  const { data: employee } = await supabase
    .from("employees")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const home = homeForRole(employee?.role);
  if (options?.welcome && home === "/dashboard") {
    window.location.replace("/dashboard?profile=1");
    return;
  }
  window.location.replace(home);
}

export function AuthScreen({
  path,
  navigate,
}: {
  path: string;
  navigate: (path: string) => void;
}) {
  const recovery = path !== "/login";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err === "profile") {
      setError(
        "No employee profile found for this account. Ask an admin to add you, then sign in again.",
      );
    }
    if (err === "auth") {
      setError("Could not complete sign-in. Try again.");
    }
    if (path === "/reset-password") {
      void applyInviteSessionFromUrl();
    }
  }, [path]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    setBusy(true);
    const supabase = createClient();

    try {
      if (path === "/login") {
        const { error: signError } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (signError) {
          setError(signError.message);
          return;
        }
        await redirectHome(supabase);
        return;
      }

      if (path === "/forgot-password") {
        const { error: resetError } = await supabase.auth.resetPasswordForEmail(
          email,
          {
            redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
          },
        );
        if (resetError) {
          setError(resetError.message);
          return;
        }
        setMessage("Check your email for a reset link.");
        return;
      }

      if (password !== confirm) {
        setError("Passwords do not match.");
        return;
      }
      if (password.length < 8) {
        setError("Use at least 8 characters.");
        return;
      }

      await applyInviteSessionFromUrl();
      const { error: updateError } = await supabase.auth.updateUser({
        password,
      });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      const welcome =
        new URLSearchParams(window.location.search).get("welcome") === "1";
      await redirectHome(supabase, { welcome });
    } finally {
      setBusy(false);
    }
  }

  const title =
    path === "/forgot-password"
      ? "Reset your password"
      : path === "/reset-password"
        ? "Create a new password"
        : "Sign in to Kachabiti HR";

  const actionLabel = busy
    ? "Please wait…"
    : path === "/forgot-password"
      ? "Send reset link"
      : path === "/reset-password"
        ? "Update password"
        : "Sign in";

  return (
    <div className="auth-shell">
      <aside className="auth-showcase">
        <div className="auth-showcase-brand">
          <Logo dark />
        </div>
        <div className="auth-showcase-copy">
          <span className="auth-showcase-badge">
            <ShieldCheck size={14} /> Secure HR workspace
          </span>
          <h2>Time off, organized for everyone.</h2>
          <p>
            A clear place for your team to request leave, manage approvals,
            and stay aligned.
          </p>
          <ul>
            <li>
              <Check size={15} /> Track leave and authorization balances
            </li>
            <li>
              <Check size={15} /> Review requests without losing context
            </li>
            <li>
              <Check size={15} /> Keep the whole team calendar visible
            </li>
          </ul>
        </div>
        <p className="auth-showcase-footer">
          Kachabiti · Leave management for modern teams
        </p>
      </aside>

      <main className="auth-main">
        <div className="auth-mobile-brand">
          <Logo />
        </div>
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-card-head">
            <div className="auth-icon">
              {recovery ? <KeyRound size={20} /> : <ShieldCheck size={20} />}
            </div>
            <p className="eyebrow">
              {recovery ? "Account recovery" : "Welcome back"}
            </p>
            <h1>{title}</h1>
            <p>
              {path === "/forgot-password"
                ? "Enter your work email and we’ll send you a secure reset link."
                : path === "/reset-password"
                  ? "Choose a secure password with at least 8 characters."
                  : "Enter your work credentials to access your workspace."}
            </p>
          </div>

          <div className="auth-fields">
            {path !== "/reset-password" && (
              <div className="auth-field">
                <span>
                  <label htmlFor="auth-email">Work email</label>
                </span>
                <div className="auth-input">
                  <Mail size={17} />
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="name@kachabiti.com"
                    autoComplete="email"
                    required
                  />
                </div>
              </div>
            )}

            {path !== "/forgot-password" && (
              <div className="auth-field">
                <span>
                  <label htmlFor="auth-password">
                    {path === "/reset-password"
                      ? "New password"
                      : "Password"}
                  </label>
                  {path === "/login" && (
                    <button
                      type="button"
                      onClick={() => navigate("/forgot-password")}
                    >
                      Forgot password?
                    </button>
                  )}
                </span>
                <div className="auth-input">
                  <KeyRound size={17} />
                  <input
                    id="auth-password"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={
                      path === "/reset-password"
                        ? "At least 8 characters"
                        : "Enter your password"
                    }
                    autoComplete={
                      path === "/login" ? "current-password" : "new-password"
                    }
                    minLength={path === "/reset-password" ? 8 : undefined}
                    required
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    onClick={() => setShowPassword((visible) => !visible)}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            )}

            {path === "/reset-password" && (
              <div className="auth-field">
                <span>
                  <label htmlFor="auth-password-confirm">
                    Confirm password
                  </label>
                </span>
                <div className="auth-input">
                  <KeyRound size={17} />
                  <input
                    id="auth-password-confirm"
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    placeholder="Repeat your new password"
                    autoComplete="new-password"
                    minLength={8}
                    required
                  />
                </div>
              </div>
            )}
          </div>

          {(error || message) && (
            <p
              className={`auth-feedback ${error ? "is-error" : "is-success"}`}
              role={error ? "alert" : "status"}
            >
              {error || message}
            </p>
          )}

          <button className="auth-submit" type="submit" disabled={busy}>
            <span>{actionLabel}</span>
            <ArrowRight size={17} />
          </button>

          {recovery && (
            <button
              type="button"
              className="back-link"
              onClick={() => navigate("/login")}
            >
              <ArrowLeft size={14} /> Back to sign in
            </button>
          )}

          <p className="auth-help">
            Need access? Contact your Kachabiti HR administrator.
          </p>
        </form>
      </main>
    </div>
  );
}
