// Emails of people who have actually stayed at Zenfulcove: non-cancelled
// Lodgify bookings whose stay has started (Historic = departed, Current = on
// site now). Used to split promotions into past-guest / everyone-else sends.
import { getAllBookings } from "@/lib/lodgify";
import { lodgifyBookingStatus } from "@/lib/access-code-messages";

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function pastGuestEmailsFromBookings(bookings) {
  const emails = new Set();
  for (const booking of bookings || []) {
    const status = String(lodgifyBookingStatus(booking) || "").toLowerCase();
    if (status.includes("cancel") || status.includes("declined")) continue;
    const guest = booking?.guest || booking?.customer || {};
    const email = normalizeEmail(guest.email || booking?.guestEmail || booking?.email);
    if (email && email.includes("@")) emails.add(email);
  }
  return emails;
}

export async function getPastGuestEmails() {
  const bookings = [];
  // Lodgify v2 ignores stayFrom/stayTo; stayFilter selects the window.
  for (const stayFilter of ["Historic", "Current"]) {
    bookings.push(...(await getAllBookings({
      stayFilter,
      page: 1,
      size: 100,
      includeCount: false,
      includeTransactions: false,
      includeExternal: true,
      includeQuoteDetails: false,
    })));
  }
  return pastGuestEmailsFromBookings(bookings);
}
