import { env, localPhoneAuthBypassEnabled } from "@shared/environment";
import { isE164PhoneNumber } from "./phone-number";

export function isPhoneEnrollmentAllowed(phoneNumber: string) {
  if (!isE164PhoneNumber(phoneNumber)) return false;
  if (localPhoneAuthBypassEnabled) return true;
  return env.PRIVATE_ALLOWED_PHONE_NUMBERS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(phoneNumber);
}
