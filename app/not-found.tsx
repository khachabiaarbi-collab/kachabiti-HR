"use client";

import { Compass } from "lucide-react";
import { Logo } from "@/components/primitives";
import { useT } from "@/lib/i18n";

export default function NotFound() {
  const t = useT();
  return (
    <main className="status-page">
      <Logo />
      <div className="status-card">
        <div className="status-icon">
          <Compass size={22} />
        </div>
        <p className="status-code">404</p>
        <h1>{t("notFound.title")}</h1>
        <p>{t("notFound.copy")}</p>
        <a className="primary-button" href="/">
          {t("notFound.back")}
        </a>
      </div>
    </main>
  );
}
