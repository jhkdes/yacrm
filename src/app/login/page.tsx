import { loginAction } from "@/app/actions";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;

  return (
    <main
      style={{
        padding: "2rem",
        fontFamily: "sans-serif",
        maxWidth: "24rem",
        margin: "4rem auto",
      }}
    >
      <h1>yaCRM</h1>
      <form action={loginAction}>
        <input type="hidden" name="next" value={params.next ?? "/"} />
        <p>
          <label>
            Password:{" "}
            <input
              type="password"
              name="password"
              autoFocus
              required
              style={{ width: "100%" }}
            />
          </label>
        </p>
        {params.error && (
          <p style={{ color: "crimson" }}>Wrong password.</p>
        )}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
