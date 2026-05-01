"use server";

import { AuthError } from "next-auth";

import { signIn } from "@/lib/auth";

// useActionState 兼容签名：(prevState, formData) → newState
export async function loginAction(
  _prevState: string | undefined,
  formData: FormData,
): Promise<string | undefined> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/classes",
    });
    return undefined;
  } catch (error) {
    if (error instanceof AuthError) {
      switch (error.type) {
        case "CredentialsSignin":
          return "邮箱或密码错误";
        default:
          return "登录失败，请稍后重试";
      }
    }
    // signIn 成功时会抛 NEXT_REDIRECT，必须 rethrow 让 Next 完成跳转
    throw error;
  }
}
