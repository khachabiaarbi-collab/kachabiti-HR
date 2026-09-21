import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

function copyCookies(from: NextResponse, to: NextResponse) {
  from.cookies.getAll().forEach(({ name, value }) => {
    to.cookies.set(name, value)
  })
  return to
}

function homeForRole(role: string | null | undefined) {
  return role === 'admin' || role === 'manager' ? '/admin' : '/dashboard'
}

function isAppPath(path: string) {
  return path === '/' || path.startsWith('/dashboard') || path.startsWith('/admin')
}

export async function middleware(request: NextRequest) {
  const { supabase, supabaseResponse, user } = await updateSession(request)
  const path = request.nextUrl.pathname

  const redirectTo = (pathname: string, search = '') => {
    const url = request.nextUrl.clone()
    url.pathname = pathname
    url.search = search
    return copyCookies(supabaseResponse, NextResponse.redirect(url))
  }

  const replaceTo = (pathname: string) => {
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><script>location.replace(${JSON.stringify(pathname)})</script></head><body></body></html>`
    const res = new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
    return copyCookies(supabaseResponse, res)
  }

  if (!user && isAppPath(path)) {
    return replaceTo('/login')
  }

  if (!user) {
    supabaseResponse.headers.set('Cache-Control', 'no-store')
    return supabaseResponse
  }

  const { data: employee } = await supabase
    .from('employees')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!employee) {
    if (
      path.startsWith('/reset-password') ||
      path.startsWith('/forgot-password') ||
      path.startsWith('/auth/callback')
    ) {
      return supabaseResponse
    }
    await supabase.auth.signOut()
    return redirectTo('/login', '?error=profile')
  }

  const home = homeForRole(employee.role)

  if (path === '/' || path.startsWith('/login')) {
    return replaceTo(home)
  }

  if (employee.role === 'employee' && path.startsWith('/admin')) {
    return replaceTo('/dashboard')
  }

  if ((employee.role === 'admin' || employee.role === 'manager') && path.startsWith('/dashboard')) {
    return replaceTo('/admin')
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
