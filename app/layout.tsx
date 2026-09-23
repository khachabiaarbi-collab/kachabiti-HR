import { Analytics } from '@vercel/analytics/next'
import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { LanguageProvider, type Locale } from '@/lib/i18n'
import './globals.css'

export const metadata: Metadata = {
  title: 'Kachabiti | Leave management for modern teams',
  description: 'A simple, thoughtful way to manage time off, approvals, and team availability.',
  generator: 'v0.app',
}

export const viewport: Viewport = {
  colorScheme: 'light',
  themeColor: '#f7f8fc',
  userScalable: true,
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const stored = (await cookies()).get('kachabiti-locale')?.value
  const locale: Locale = stored === 'fr' ? 'fr' : 'en'

  return (
    <html lang={locale} className="bg-background" suppressHydrationWarning>
      <body className="antialiased">
        <LanguageProvider initialLocale={locale}>{children}</LanguageProvider>
        {process.env.NODE_ENV === 'production' && <Analytics />}
      </body>
    </html>
  )
}
