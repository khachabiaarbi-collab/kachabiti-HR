import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type EmailOtpType =
  | 'signup'
  | 'invite'
  | 'magiclink'
  | 'recovery'
  | 'email_change'
  | 'email'

function safePath(next: string | null) {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return null
  return next
}

function destinationFor(type: string | null, requested: string | null) {
  if (type === 'invite') return '/reset-password?welcome=1'
  if (type === 'recovery' || requested === '/reset-password') {
    return '/reset-password'
  }
  return requested ?? '/dashboard'
}

function callbackClient(request: NextRequest, response: NextResponse) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )
}

function implicitBridge(origin: string) {
  const reset = JSON.stringify(`${origin}/reset-password`)
  const login = JSON.stringify(`${origin}/login?error=auth`)
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>
(function () {
  var hash = location.hash || "";
  var params = new URLSearchParams(hash.charAt(0) === "#" ? hash.slice(1) : "");
  var type = params.get("type");
  if (params.get("access_token") && params.get("refresh_token") && (type === "invite" || type === "recovery")) {
    location.replace(${reset} + (type === "invite" ? "?welcome=1" : "") + hash);
    return;
  }
  location.replace(${login});
})();
</script></head><body></body></html>`
  return new NextResponse(html, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null
  const next = destinationFor(type, safePath(searchParams.get('next')))

  if (code || (tokenHash && type)) {
    const response = NextResponse.redirect(`${origin}${next}`)
    const supabase = callbackClient(request, response)
    const { error } =
      code && !tokenHash
        ? await supabase.auth.exchangeCodeForSession(code)
        : await supabase.auth.verifyOtp({
            type: type as EmailOtpType,
            token_hash: tokenHash as string,
          })
    if (!error) return response
    return NextResponse.redirect(`${origin}/login?error=auth`)
  }

  return implicitBridge(origin)
}
