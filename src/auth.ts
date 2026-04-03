import NextAuth from "next-auth"
import Google from "next-auth/providers/google"
import { createClient } from "@supabase/supabase-js"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "placeholder-service-key"
)

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID!,
      clientSecret: process.env.AUTH_GOOGLE_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "google") return false

      // Check if user exists in our users table
      const { data: existingUser } = await supabaseAdmin
        .from("users")
        .select("id, email")
        .eq("email", user.email!)
        .single()

      // Only allow pre-registered users (admin must add them first)
      if (!existingUser) {
        return false // Block unknown Google accounts
      }

      // Update google_id and avatar if first login
      await supabaseAdmin
        .from("users")
        .update({
          google_id: account.providerAccountId,
          avatar_url: user.image,
          name: user.name,
        })
        .eq("email", user.email!)

      return true
    },
    async session({ session }) {
      if (session.user?.email) {
        const { data: dbUser } = await supabaseAdmin
          .from("users")
          .select("id, is_admin, name, avatar_url")
          .eq("email", session.user.email)
          .single()

        if (dbUser) {
          session.user.id = dbUser.id
          session.user.is_admin = dbUser.is_admin
          session.user.name = dbUser.name
          session.user.image = dbUser.avatar_url
        }
      }
      return session
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
})
