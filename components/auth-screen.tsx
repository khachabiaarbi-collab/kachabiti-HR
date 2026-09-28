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
import { LanguageSwitcher } from "@/components/language-switcher";
import { Logo } from "@/components/primitives";
import { useT } from "@/lib/i18n";

function homeForRole(role: string | null | undefined) {
  return role === "admin" || role === "manager" ? "/admin" : "/dashboard";
}

function passwordLinkFromHash() {
  const hash = window.location.hash.startsWith("#")
    ? window.location.hash.slice(1)
    : "";
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const type = params.get("type");
  if (
    !params.get("access_token") ||
    !params.get("refresh_token") ||
    (type !== "invite" && type !== "recovery")
  ) {
    return null;
  }
  const welcome = type === "invite" ? "?welcome=1" : "";
  return `/reset-password${welcome}${window.location.hash}`;
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
  const { error } = await supabase.auth.setSession({
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  if (error) return error.message;
  const search = new URLSearchParams(window.location.search);
  if (params.get("type") === "invite") search.set("welcome", "1");
  const query = search.toString();
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}`,
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
  const t = useT();

  useEffect(() => {
    const passwordLink = passwordLinkFromHash();
    if (passwordLink && path !== "/reset-password") {
      window.location.replace(passwordLink);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const err = params.get("error");
    if (err === "profile") {
      setError(t("auth.noProfile"));
    }
    if (err === "auth") {
      setError(t("auth.signInFailed"));
    }
    if (path === "/reset-password") {
      void applyInviteSessionFromUrl().then((message) => {
        if (message) setError(message);
      });
    }
  }, [path, t]);

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
        setMessage(t("auth.resetSent"));
        return;
      }

      if (password !== confirm) {
        setError(t("auth.passwordMismatch"));
        return;
      }
      if (password.length < 8) {
        setError(t("auth.passwordShort"));
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
      ? t("auth.forgotTitle")
      : path === "/reset-password"
        ? t("auth.resetTitle")
        : t("auth.signInTitle");

  const actionLabel = busy
    ? t("auth.pleaseWait")
    : path === "/forgot-password"
      ? t("auth.sendReset")
      : path === "/reset-password"
        ? t("auth.updatePassword")
        : t("auth.signIn");

  return (
    <div className="auth-shell">
      <aside className="auth-showcase">
        <div className="auth-showcase-brand">
          <Logo dark />
        </div>
        <div className="auth-showcase-copy">
          <span className="auth-showcase-badge">
            <ShieldCheck size={14} /> {t("auth.secure")}
          </span>
          <h2>{t("auth.showcaseTitle")}</h2>
          <p>{t("auth.showcaseBody")}</p>
          <ul>
            <li>
              <Check size={15} /> {t("auth.feature1")}
            </li>
            <li>
              <Check size={15} /> {t("auth.feature2")}
            </li>
            <li>
              <Check size={15} /> {t("auth.feature3")}
            </li>
          </ul>
        </div>
        <p className="auth-showcase-footer">{t("auth.footer")}</p>
      </aside>

      <main className="auth-main">
        <div className="auth-mobile-brand">
          <Logo />
        </div>
        <form className="auth-card" onSubmit={submit}>
          <div className="auth-lang">
            <LanguageSwitcher compact />
          </div>
          <div className="auth-card-head">
            <div className="auth-icon">
              {recovery ? <KeyRound size={20} /> : <ShieldCheck size={20} />}
            </div>
            <p className="eyebrow">
              {recovery ? t("auth.recovery") : t("auth.welcome")}
            </p>
            <h1>{title}</h1>
            <p>
              {path === "/forgot-password"
                ? t("auth.forgotSubtitle")
                : path === "/reset-password"
                  ? t("auth.resetSubtitle")
                  : t("auth.signInSubtitle")}
            </p>
          </div>

          <div className="auth-fields">
            {path !== "/reset-password" && (
              <div className="auth-field">
                <span>
                  <label htmlFor="auth-email">{t("auth.workEmail")}</label>
                </span>
                <div className="auth-input">
                  <Mail size={17} />
                  <input
                    id="auth-email"
                    type="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={t("auth.emailPlaceholder")}
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
                      ? t("auth.newPassword")
                      : t("auth.password")}
                  </label>
                  {path === "/login" && (
                    <button
                      type="button"
                      onClick={() => navigate("/forgot-password")}
                    >
                      {t("auth.forgotLink")}
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
                        ? t("auth.newPasswordPlaceholder")
                        : t("auth.passwordPlaceholder")
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
                      showPassword ? t("auth.hidePassword") : t("auth.showPassword")
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
                    {t("auth.confirmPassword")}
                  </label>
                </span>
                <div className="auth-input">
                  <KeyRound size={17} />
                  <input
                    id="auth-password-confirm"
                    type={showPassword ? "text" : "password"}
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    placeholder={t("auth.confirmPlaceholder")}
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
              <ArrowLeft size={14} /> {t("auth.back")}
            </button>
          )}

          <p className="auth-help">
            {t("auth.help")}
          </p>
        </form>
      </main>
    </div>
  );
}
