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

export interface MoneySet {
  shopMoney: ShopMoney;
  presentmentMoney: ShopMoney;
}

export interface Refund {
  id: string;
  createdAt: string;
  refundLineItems: RefundLineItem[];
  // Add other fields like duties, orderAdjustments, etc. if needed
}

export interface RefundLineItem {
  id: string;
  lineItemId: string;
  quantity: number;
  subtotalSet: MoneySet;
  totalTaxSet: MoneySet;
}

export interface Order {
  id: string;
  totalPriceSet: {
    shopMoney: ShopMoney;
  };
  customer: Customer;
  refunds: Refund[];
  createdAt: string;
  discountCodes: string[];
}

export type ProfileToAdd = {
  id?: string;
  first_name: string;
  last_name: string;
  email: string;
  address: string;
  city: string;
  zip_code: string;
  segment_id: string;
  in_robinson: boolean;
  custom_variable?: string | null;
  demo?: boolean;
};

export interface KlaviyoSegmentProfile {
  [key: string]: any;
  id: string;
  attributes: {
    [key: string]: any;
    email: string;
    first_name: string;
    last_name: string;
    location: {
      [key: string]: any;
      address1: string;
      city: string;
      country: string;
      zip: string;
    };
    properties: {
      custom_variable: string;
    }
  };
}

export interface KlaviyoSegment {
  type: string;
  id: string;
  attributes: {
    name: string;
    definition: string | null;
    created: string;
    updated: string;
    is_active: boolean;
    is_processing: boolean;
    is_starred: boolean;
  };
  relationships: {
    profiles: {
      links: {
        self: string;
        related: string;
      };
    };
    tags: {
      links: {
        self: string;
        related: string;
      };
    };
  };
  links: {
    self: string;
  };
}