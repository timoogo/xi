"use server";

import { headers } from "next/headers";
import { isAPIError } from "better-auth/api";
import { getAuth } from "../auth";
import { loginSchema, registerSchema, type LoginValues, type RegisterValues } from "../scheme/auth-scheme";

type AuthResult = { ok: true } | { ok: false; message: string };

function authError(error: unknown): AuthResult {
  if (isAPIError(error)) {
    if (error.body?.code === "USER_ALREADY_EXISTS" || error.body?.code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
      return { ok: false, message: "This email is already registered. Please log in." };
    }
    if (error.status === "TOO_MANY_REQUESTS") return { ok: false, message: "Too many attempts. Please try again later." };
    if (error.status === "UNAUTHORIZED") return { ok: false, message: "Invalid email or password." };
    if (error.status === "BAD_REQUEST") return { ok: false, message: "Please check your details and try again." };
  }
  return { ok: false, message: "Authentication is temporarily unavailable. Please try again later." };
}

export async function logIn(data: LoginValues): Promise<AuthResult> {
  const parsed = loginSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: "Please enter a valid email and your password." };
  try {
    await getAuth().api.signInEmail({ body: parsed.data, headers: await headers() });
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}

export async function Register(data: RegisterValues): Promise<AuthResult> {
  const parsed = registerSchema.safeParse(data);
  if (!parsed.success) return { ok: false, message: "Please check your name, email, password and password confirmation." };
  const { name, email, password } = parsed.data;
  try {
    await getAuth().api.signUpEmail({ body: { name, email, password }, headers: await headers() });
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}

export async function Logout(): Promise<AuthResult> {
  try {
    await getAuth().api.signOut({ headers: await headers() });
    return { ok: true };
  } catch (error) {
    return authError(error);
  }
}
