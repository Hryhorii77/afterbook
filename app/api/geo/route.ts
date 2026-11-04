import { NextResponse } from 'next/server';
import { getGeoInfo } from '@/lib/server/geo';

export async function GET() {
  return NextResponse.json(await getGeoInfo());
}
