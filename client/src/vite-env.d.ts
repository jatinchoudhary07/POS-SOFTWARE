/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RESTAURANT_NAME?: string;
  readonly VITE_API_URL?: string;
  /** WhatsApp number (country code + digits) that staff message to get a login. */
  readonly VITE_OWNER_WHATSAPP?: string;
}
