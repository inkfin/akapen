"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { loginAction } from "./actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      {pending ? "登录中..." : "登录"}
    </Button>
  );
}

export function LoginForm() {
  const [errorMessage, formAction] = useActionState<
    string | undefined,
    FormData
  >(loginAction, undefined);

  return (
    <form action={formAction} className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="email">邮箱</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="teacher@example.com"
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="password">密码</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={6}
        />
      </div>
      {errorMessage ? (
        <p className="text-sm text-[--color-destructive]" role="alert">
          {errorMessage}
        </p>
      ) : null}
      <SubmitButton />
    </form>
  );
}
