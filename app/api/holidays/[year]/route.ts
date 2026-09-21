import { NextResponse } from "next/server";

type RouteContext = {
  params: Promise<{ year: string }>;
};

export async function GET(_request: Request, context: RouteContext) {
  const { year } = await context.params;
  const parsed = Number(year);
  if (!Number.isInteger(parsed) || parsed < 1990 || parsed > 2100) {
    return NextResponse.json([]);
  }

  const response = await fetch(
    `https://date.nager.at/api/v3/PublicHolidays/${parsed}/TN`,
    { next: { revalidate: 86400 } },
  );
  if (!response.ok) {
    return NextResponse.json([]);
  }

  const data: unknown = await response.json();
  return NextResponse.json(Array.isArray(data) ? data : []);
}
