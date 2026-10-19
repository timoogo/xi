"use client";

import React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormMessage,
} from "@/components/ui/form";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { XiLogo } from "@/components/xi-logo";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Register } from "../apis/auth";
import { registerSchema, RegisterValues } from "../scheme/auth-scheme";

export default function RegisterForm() {
  const router = useRouter();

  const form = useForm<RegisterValues>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      rePassword: "",
    },
  });

  const onSubmit = async (data: RegisterValues) => {
    try {
      const response = await Register(data);
      if (!response.ok) {
        toast.error(response.message);
        return;
      }
      toast.success("Account created!");
      router.replace("/dashboard");
      router.refresh();
    } catch {
      toast.error("Unable to register. Please try again later.");
    }
  };

  return (
    <div className="w-[580px] h-[500px] mx-7 flex flex-col justify-center items-center">
      {/* Heading */}
      <div className="flex items-center gap-2">
        <XiLogo size={40} />
        <div className="text-center">
          <h1 className="text-primary font-bold">Xi</h1>
          <h3 className="text-muted-foreground">Your private space</h3>
        </div>
      </div>

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4 my-5 w-full max-w-md"
        >
          {/* Name */}
          <FormField
            name="name"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="text"
                    placeholder="Full name"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Email */}
          <FormField
            name="email"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="email"
                    placeholder="you@example.com"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Password */}
          <FormField
            name="password"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="password"
                    placeholder="Password"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Confirm Password */}
          <FormField
            name="rePassword"
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormControl>
                  <Input
                    type="password"
                    placeholder="Confirm password"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button className="w-full" type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? "Registering…" : "Register"}
          </Button>

          <p className="text-primary text-center cursor-pointer text-sm">
            Have an account?{" "}
            <Link href="/auth/login">
              <span className="text-chart-1">Log In</span>
            </Link>
          </p>
        </form>
      </Form>
    </div>
  );
}
