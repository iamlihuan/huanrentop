import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import prisma from "@/lib/server/prisma";

const TOKEN = process.env.OPS_TOKEN ?? "";

function authorized(request: NextRequest): boolean {
  if (!TOKEN) return false;
  const provided =
    request.headers.get("x-ops-token") ??
    new URL(request.url).searchParams.get("token") ??
    "";
  if (provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i += 1) {
    diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  }
  return diff === 0;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!authorized(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const slug = url.searchParams.get("slug") ?? "/";
  const page = await prisma.page.findFirst({
    where: { slug, deletedAt: null },
    select: {
      id: true,
      slug: true,
      title: true,
      updatedAt: true,
      config: true,
      metaDescription: true,
    },
  });
  return NextResponse.json({ ok: true, page });
}
