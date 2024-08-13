import { Profile } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";
import { Database } from "./types";

export const API_URL = process.env.NODE_ENV === 'production' ? 'https://api.postbuddy.dk' : 'http://localhost:8000';
export const WEB_URL = process.env.NODE_ENV === 'production' ? 'https://app.postbuddy.dk' : 'http://localhost:3000';
export const config = {
  license: process.env.IMGLY_LICENSE,
}
export const testProfile: Profile = {
  id: 'test',
  first_name: 'John',
  last_name: 'Doe',
  created_at: new Date(),
  email: 'john@doe.dk',
  address: 'Testvej 1',
  city: 'Testby',
  zip_code: '1234',
  segment_id: 'test',
  in_robinson: false,
  custom_variable: null,
  demo: true,
  country: 'Danmark',
  klaviyo_id: 'test',
  letter_sent: false,
  letter_sent_at: null,
  company: null,
}
export const pricePerLetter = 7.5
export const JWT_EXPIRATION_TIME = '1d';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);