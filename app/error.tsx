"use client";

import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { Logo } from "@/components/primitives";
import { useT } from "@/lib/i18n";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="status-page">
      <Logo />
      <div className="status-card">
        <div className="status-icon status-icon-error">
          <TriangleAlert size={22} />
        </div>
        <h1>{t("error.title")}</h1>
        <p>{t("error.copy")}</p>
        <div className="status-actions">
          <button type="button" className="primary-button" onClick={reset}>
            {t("common.tryAgain")}
          </button>
          <a className="secondary-button" href="/">
            {t("notFound.back")}
          </a>
        </div>
      </div>
    </main>
  );
}
