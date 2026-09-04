import { NextResponse } from 'next/server';
import { getGeoInfo } from '@/lib/geo';

export async function GET() {
  return NextResponse.json(await getGeoInfo());
}
