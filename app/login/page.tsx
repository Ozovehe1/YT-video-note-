import { AuthForm } from "@/components/auth-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; checkEmail?: string }>;
}) {
  const { next, checkEmail } = await searchParams;
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center px-5 py-16 sm:px-8">
      <AuthForm
        mode="login"
        next={next ?? "/library"}
        notice={checkEmail ? "Check your email to confirm your account, then sign in." : undefined}
      />
    </main>
  );
}
