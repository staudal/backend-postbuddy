export interface ShopMoney {
  amount: string;
  currencyCode: string;
}

export interface Address {
  address1: string;
  zip: string;
  city: string;
  country: string;
}

export interface Customer {
  firstName: string;
  lastName: string;
  email: string;
  addresses: Address[];
}

export interface Order {
  id: string;
  totalPriceSet: {
    shopMoney: ShopMoney;
  };
  customer: Customer;
  createdAt: string;
  discountCodes: string[];
}
