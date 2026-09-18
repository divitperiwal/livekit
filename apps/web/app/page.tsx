import { redirect } from "next/navigation";

export default function Home() {
  // The proxy sends anyone without a session to /login before this runs.
  redirect("/calls");
}
