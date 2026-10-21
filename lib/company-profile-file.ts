import { extensionFor } from "./employee-avatar-file";

export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** Upper bound of the monthly vacation rate, as in 03_company_settings.sql. */
export const MAX_MONTHLY_LEAVE_DAYS = 5;

export function companyLogoPath(organizationId: string, type: string): string {
  return `${organizationId}/logo.${extensionFor(type)}`;
}

export function logoFileIssue(
  file: { type: string; size: number } | null,
): string | null {
  if (!file || file.size === 0) return "Choose a logo to upload";
  if (!LOGO_TYPES.includes(file.type as (typeof LOGO_TYPES)[number])) {
    return "Use a JPG, PNG, or WEBP image";
  }
  if (file.size > LOGO_MAX_BYTES) return "Logo must be 2 MB or smaller";
  return null;
}

/** "#1F3A8A", "1f3a8a" or "#13a" → "#1f3a8a"; anything else → null. */
export function normalizeBrandColor(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(raw)) {
    return `#${raw.split("").map((digit) => digit + digit).join("")}`;
  }
  return /^[0-9a-f]{6}$/.test(raw) ? `#${raw}` : null;
}

function luminance(hex: string) {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastWithWhite(hex: string) {
  return 1.05 / (luminance(hex) + 0.05);
}

/** Text colour (white or near-black) with the better contrast on the brand colour. */
export function brandForeground(hex: string): "#ffffff" | "#171717" {
  const onDark = (luminance(hex) + 0.05) / (luminance("#171717") + 0.05);
  return contrastWithWhite(hex) >= onDark ? "#ffffff" : "#171717";
}

/**
 * CSS variables for a company colour, set on the app shell. Buttons and
 * logo marks always take it; the design system's accent (--ds-primary, also
 * used as text on white) only when it is readable there (WCAG AA, 4.5:1).
 */
export function brandTheme(hex: string): Record<string, string> {
  const theme: Record<string, string> = {
    "--brand": hex,
    "--brand-foreground": brandForeground(hex),
    "--brand-hover": `color-mix(in srgb, ${hex} 88%, #000)`,
  };
  if (contrastWithWhite(hex) >= 4.5) {
    theme["--ds-primary"] = hex;
    theme["--ds-primary-hover"] = theme["--brand-hover"];
    theme["--ds-primary-soft"] = `color-mix(in srgb, ${hex} 9%, #fff)`;
    theme["--ds-focus"] = `0 0 0 3px color-mix(in srgb, ${hex} 22%, transparent)`;
  }
  return theme;
}

export function companyInitial(name: string): string {
  return (name.trim()[0] ?? "R").toUpperCase();
}

export type CompanyProfileInput = {
  name: string;
  brandColor: string;
  monthlyLeaveDays: string | number;
};

export function companyProfileIssue(input: CompanyProfileInput): string | null {
  const name = input.name.trim();
  if (!name) return "Company name is required";
  if (name.length > 120) return "Company name must be 120 characters or fewer";
  if (input.brandColor.trim() && !normalizeBrandColor(input.brandColor)) {
    return "Enter the colour as a hex code, for example #1f3a8a";
  }
  const rate = Number(String(input.monthlyLeaveDays).trim());
  if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_MONTHLY_LEAVE_DAYS) {
    return `Enter a monthly leave rate above 0 and up to ${MAX_MONTHLY_LEAVE_DAYS}`;
  }
  return null;
}
