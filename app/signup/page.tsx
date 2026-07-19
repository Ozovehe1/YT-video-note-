import { AuthForm } from "@/components/auth-form";

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-6xl items-center px-5 py-16 sm:px-8">
      <AuthForm mode="signup" />
    </main>
  );
}
