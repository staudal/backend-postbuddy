import { Profile } from "@prisma/client";

export const API_URL = process.env.NODE_ENV === 'production' ? 'https://api.postbuddy.dk' : 'http://localhost:8000';
export const WEB_URL = process.env.NODE_ENV === 'production' ? 'https://app.postbuddy.dk' : 'http://localhost:3000';
export const config = {
  license: process.env.IMGLY_LICENSE,
}
export const testProfile: Profile = {
  id: 'test',
  first_name: 'John',
  last_name: 'Doe',
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
}
export const pricePerLetter = 7.5