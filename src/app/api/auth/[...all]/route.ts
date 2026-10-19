import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth";

export const runtime = "nodejs";
const handler = (request: Request) => getAuth().handler(request);
export const { GET, POST } = toNextJsHandler(handler);
