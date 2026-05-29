import { redirect } from "next/navigation";

// Admin index — redirect to the only admin page that exists today. Replace when more admin
// pages are added (e.g., /admin/instruments, /admin/accounts).
export default function AdminIndex() {
  redirect("/admin/strategies");
}
