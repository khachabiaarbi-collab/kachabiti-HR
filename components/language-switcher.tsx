"use client";

import { useLanguage, type Locale } from "@/lib/i18n";

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useLanguage();

  const choose = (next: Locale) => {
    if (next !== locale) setLocale(next);
  };

  return (
    <div
      className={`language-switcher${compact ? " is-compact" : ""}`}
      role="group"
      aria-label={t("lang.switch")}
    >
      <button
        type="button"
        className={locale === "en" ? "is-active" : undefined}
        aria-pressed={locale === "en"}
        onClick={() => choose("en")}
      >
        {t("lang.en")}
      </button>
      <button
        type="button"
        className={locale === "fr" ? "is-active" : undefined}
        aria-pressed={locale === "fr"}
        onClick={() => choose("fr")}
      >
        {t("lang.fr")}
      </button>
    </div>
  );
}
