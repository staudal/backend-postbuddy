export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      campaigns: {
        Row: {
          created_at: string;
          demo: boolean;
          design_id: string;
          discount_codes: string[] | null;
          id: string;
          name: string;
          segment_id: string;
          start_date: string;
          status: string;
          type: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          demo?: boolean;
          design_id: string;
          discount_codes?: string[] | null;
          id?: string;
          name: string;
          segment_id: string;
          start_date?: string;
          status: string;
          type: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          demo?: boolean;
          design_id?: string;
          discount_codes?: string[] | null;
          id?: string;
          name?: string;
          segment_id?: string;
          start_date?: string;
          status?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "campaigns_design_id_fkey";
            columns: ["design_id"];
            isOneToOne: false;
            referencedRelation: "designs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_segment_id_fkey";
            columns: ["segment_id"];
            isOneToOne: false;
            referencedRelation: "segments";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "campaigns_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      designs: {
        Row: {
          created_at: string;
          demo: boolean;
          format: string;
          id: string;
          name: string;
          scene: string | null;
          thumbnail: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          demo?: boolean;
          format: string;
          id?: string;
          name: string;
          scene?: string | null;
          thumbnail?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          demo?: boolean;
          format?: string;
          id?: string;
          name?: string;
          scene?: string | null;
          thumbnail?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "designs_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      integrations: {
        Row: {
          created_at: string;
          id: string;
          klaviyo_api_key: string | null;
          scopes: string | null;
          shop: string | null;
          token: string | null;
          token_created_at: string | null;
          type: string;
          user_id: string;
          verifier: string | null;
        };
        Insert: {
          created_at?: string;
          id?: string;
          klaviyo_api_key?: string | null;
          scopes?: string | null;
          shop?: string | null;
          token?: string | null;
          token_created_at?: string | null;
          type: string;
          user_id: string;
          verifier?: string | null;
        };
        Update: {
          created_at?: string;
          id?: string;
          klaviyo_api_key?: string | null;
          scopes?: string | null;
          shop?: string | null;
          token?: string | null;
          token_created_at?: string | null;
          type?: string;
          user_id?: string;
          verifier?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "integrations_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      orders: {
        Row: {
          address: string;
          amount: number;
          created_at: string;
          discount_codes: string[] | null;
          email: string;
          first_name: string;
          id: string;
          last_name: string;
          order_id: string;
          user_id: string;
          zip_code: string;
        };
        Insert: {
          address: string;
          amount: number;
          created_at?: string;
          discount_codes?: string[] | null;
          email: string;
          first_name: string;
          id?: string;
          last_name: string;
          order_id: string;
          user_id: string;
          zip_code: string;
        };
        Update: {
          address?: string;
          amount?: number;
          created_at?: string;
          discount_codes?: string[] | null;
          email?: string;
          first_name?: string;
          id?: string;
          last_name?: string;
          order_id?: string;
          user_id?: string;
          zip_code?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orders_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      orders_profiles: {
        Row: {
          created_at: string;
          id: string;
          order_id: string;
          profile_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          order_id: string;
          profile_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          order_id?: string;
          profile_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "orders_profiles_order_id_fkey";
            columns: ["order_id"];
            isOneToOne: false;
            referencedRelation: "orders";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "orders_profiles_profile_id_fkey";
            columns: ["profile_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          address: string;
          city: string;
          country: string;
          created_at: string;
          custom_variable: string | null;
          demo: boolean;
          email: string;
          first_name: string;
          id: string;
          in_robinson: boolean;
          klaviyo_id: string | null;
          last_name: string;
          letter_sent: boolean;
          letter_sent_at: string | null;
          segment_id: string;
          zip_code: string;
        };
        Insert: {
          address: string;
          city: string;
          country?: string;
          created_at?: string;
          custom_variable?: string | null;
          demo?: boolean;
          email: string;
          first_name: string;
          id?: string;
          in_robinson?: boolean;
          klaviyo_id?: string | null;
          last_name: string;
          letter_sent?: boolean;
          letter_sent_at?: string | null;
          segment_id: string;
          zip_code: string;
        };
        Update: {
          address?: string;
          city?: string;
          country?: string;
          created_at?: string;
          custom_variable?: string | null;
          demo?: boolean;
          email?: string;
          first_name?: string;
          id?: string;
          in_robinson?: boolean;
          klaviyo_id?: string | null;
          last_name?: string;
          letter_sent?: boolean;
          letter_sent_at?: string | null;
          segment_id?: string;
          zip_code?: string;
        };
        Relationships: [
          {
            foreignKeyName: "profiles_segment_id_fkey";
            columns: ["segment_id"];
            isOneToOne: false;
            referencedRelation: "segments";
            referencedColumns: ["id"];
          },
        ];
      };
      segments: {
        Row: {
          created_at: string;
          demo: boolean;
          id: string;
          klaviyo_id: string | null;
          name: string;
          type: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          demo?: boolean;
          id?: string;
          klaviyo_id?: string | null;
          name: string;
          type: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          demo?: boolean;
          id?: string;
          klaviyo_id?: string | null;
          name?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "segments_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      subscriptions: {
        Row: {
          created_at: string;
          customer_id: string;
          id: string;
          status: string;
          subscription_id: string;
          subscription_item_id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          customer_id: string;
          id?: string;
          status: string;
          subscription_id: string;
          subscription_item_id: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          customer_id?: string;
          id?: string;
          status?: string;
          subscription_id?: string;
          subscription_item_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "subscriptions_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      uploads: {
        Row: {
          created_at: string;
          format: string;
          height: number;
          id: string;
          name: string;
          url: string;
          user_id: string;
          width: number;
        };
        Insert: {
          created_at?: string;
          format: string;
          height?: number;
          id?: string;
          name: string;
          url: string;
          user_id: string;
          width?: number;
        };
        Update: {
          created_at?: string;
          format?: string;
          height?: number;
          id?: string;
          name?: string;
          url?: string;
          user_id?: string;
          width?: number;
        };
        Relationships: [
          {
            foreignKeyName: "uploads_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
      users: {
        Row: {
          access_token: string;
          address: string | null;
          buffer_days: number;
          city: string | null;
          company: string | null;
          country: string;
          created_at: string;
          demo: boolean;
          email: string;
          first_name: string;
          id: string;
          last_name: string;
          password: string;
          role: string;
          zip_code: string | null;
        };
        Insert: {
          access_token?: string;
          address?: string | null;
          buffer_days?: number;
          city?: string | null;
          company?: string | null;
          country?: string;
          created_at?: string;
          demo?: boolean;
          email: string;
          first_name: string;
          id?: string;
          last_name: string;
          password: string;
          role?: string;
          zip_code?: string | null;
        };
        Update: {
          access_token?: string;
          address?: string | null;
          buffer_days?: number;
          city?: string | null;
          company?: string | null;
          country?: string;
          created_at?: string;
          demo?: boolean;
          email?: string;
          first_name?: string;
          id?: string;
          last_name?: string;
          password?: string;
          role?: string;
          zip_code?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "users_id_fkey";
            columns: ["id"];
            isOneToOne: true;
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type PublicSchema = Database[Extract<keyof Database, "public">];

export type Tables<
  PublicTableNameOrOptions extends
  | keyof (PublicSchema["Tables"] & PublicSchema["Views"])
  | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
  ? keyof (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
    Database[PublicTableNameOrOptions["schema"]]["Views"])
  : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? (Database[PublicTableNameOrOptions["schema"]]["Tables"] &
    Database[PublicTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
  ? R
  : never
  : PublicTableNameOrOptions extends keyof (PublicSchema["Tables"] &
    PublicSchema["Views"])
  ? (PublicSchema["Tables"] &
    PublicSchema["Views"])[PublicTableNameOrOptions] extends {
      Row: infer R;
    }
  ? R
  : never
  : never;

export type TablesInsert<
  PublicTableNameOrOptions extends
  | keyof PublicSchema["Tables"]
  | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
  ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
  : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Insert: infer I;
  }
  ? I
  : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
  ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
    Insert: infer I;
  }
  ? I
  : never
  : never;

export type TablesUpdate<
  PublicTableNameOrOptions extends
  | keyof PublicSchema["Tables"]
  | { schema: keyof Database },
  TableName extends PublicTableNameOrOptions extends { schema: keyof Database }
  ? keyof Database[PublicTableNameOrOptions["schema"]]["Tables"]
  : never = never,
> = PublicTableNameOrOptions extends { schema: keyof Database }
  ? Database[PublicTableNameOrOptions["schema"]]["Tables"][TableName] extends {
    Update: infer U;
  }
  ? U
  : never
  : PublicTableNameOrOptions extends keyof PublicSchema["Tables"]
  ? PublicSchema["Tables"][PublicTableNameOrOptions] extends {
    Update: infer U;
  }
  ? U
  : never
  : never;

export type Enums<
  PublicEnumNameOrOptions extends
  | keyof PublicSchema["Enums"]
  | { schema: keyof Database },
  EnumName extends PublicEnumNameOrOptions extends { schema: keyof Database }
  ? keyof Database[PublicEnumNameOrOptions["schema"]]["Enums"]
  : never = never,
> = PublicEnumNameOrOptions extends { schema: keyof Database }
  ? Database[PublicEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : PublicEnumNameOrOptions extends keyof PublicSchema["Enums"]
  ? PublicSchema["Enums"][PublicEnumNameOrOptions]
  : never;

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
  currentTotalPrice: string;
  customer: Customer;
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
    };
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

export interface CsvRow {
  first_name: string;
  last_name: string;
  address: string;
  zip_code: string;
  city: string;
  email: string;
  country: string;
  custom_variable?: string;
}
