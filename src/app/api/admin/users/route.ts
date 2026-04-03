import { auth } from "@/auth"
import { supabaseAdmin } from "@/lib/supabase"
import { NextRequest, NextResponse } from "next/server"

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.is_admin) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const formData = await req.formData()
  const name = formData.get("name") as string
  const email = formData.get("email") as string
  const is_admin = formData.get("is_admin") === "on"

  if (!name || !email) {
    return NextResponse.json({ error: "Name and email required" }, { status: 400 })
  }

  const { error } = await supabaseAdmin.from("users").insert({
    name,
    email: email.toLowerCase(),
    is_admin,
    google_id: email.toLowerCase(), // placeholder until they log in
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.redirect(new URL("/admin/users", req.url))
}
