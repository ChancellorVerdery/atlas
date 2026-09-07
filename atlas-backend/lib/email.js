// The one place an email address is case-folded.
//
// Both halves of auth must agree on this. They did not: signup() stored the
// address exactly as typed under a UNIQUE(email) constraint, while login()
// matched on lower(email). So two signups differing only in case both
// succeeded — the UNIQUE saw distinct text — and the resulting pair of
// accounts then matched a single login query, which picked between them by
// unordered physical row order.
//
// Addresses are case-insensitive in practice: the domain is by RFC 1035, and
// no mail provider a user of this app will have treats the local part as
// case-sensitive. Folding the whole address is what every login form here has
// effectively assumed since the first commit.
export const normalizeEmail = (v) => String(v ?? '').trim().toLowerCase()
