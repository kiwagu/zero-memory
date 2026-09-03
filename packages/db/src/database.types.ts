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
      audit_log: {
        Row: {
          actor_id: string | null;
          agent_name: string | null;
          author_kind: string | null;
          command: string;
          duration_ms: number | null;
          error: string | null;
          id: string;
          occurred_at: string;
          outcome: string;
          payload: Json | null;
          request_id: string | null;
        };
        Insert: {
          actor_id?: string | null;
          agent_name?: string | null;
          author_kind?: string | null;
          command: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          occurred_at?: string;
          outcome: string;
          payload?: Json | null;
          request_id?: string | null;
        };
        Update: {
          actor_id?: string | null;
          agent_name?: string | null;
          author_kind?: string | null;
          command?: string;
          duration_ms?: number | null;
          error?: string | null;
          id?: string;
          occurred_at?: string;
          outcome?: string;
          payload?: Json | null;
          request_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_log_actor_id_fkey';
            columns: ['actor_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      brief_probes: {
        Row: {
          created_at: string;
          expect: string;
          id: string;
          memory_id: string;
          note: string | null;
          owner_id: string;
          retired_at: string | null;
          scopes: string[] | null;
          topic: string;
        };
        Insert: {
          created_at?: string;
          expect: string;
          id?: string;
          memory_id: string;
          note?: string | null;
          owner_id: string;
          retired_at?: string | null;
          scopes?: string[] | null;
          topic: string;
        };
        Update: {
          created_at?: string;
          expect?: string;
          id?: string;
          memory_id?: string;
          note?: string | null;
          owner_id?: string;
          retired_at?: string | null;
          scopes?: string[] | null;
          topic?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'brief_probes_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'brief_probes_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      edges: {
        Row: {
          created_at: string;
          created_by: string;
          dst: string;
          id: string;
          invalidated_at: string | null;
          scope: unknown;
          source_memory: string | null;
          src: string;
          type: string;
          valid_from: string;
          weight: number;
        };
        Insert: {
          created_at?: string;
          created_by?: string;
          dst: string;
          id?: string;
          invalidated_at?: string | null;
          scope: unknown;
          source_memory?: string | null;
          src: string;
          type: string;
          valid_from?: string;
          weight?: number;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          dst?: string;
          id?: string;
          invalidated_at?: string | null;
          scope?: unknown;
          source_memory?: string | null;
          src?: string;
          type?: string;
          valid_from?: string;
          weight?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'edges_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'edges_dst_fkey';
            columns: ['dst'];
            isOneToOne: false;
            referencedRelation: 'entities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'edges_source_memory_fkey';
            columns: ['source_memory'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'edges_src_fkey';
            columns: ['src'];
            isOneToOne: false;
            referencedRelation: 'entities';
            referencedColumns: ['id'];
          },
        ];
      };
      entities: {
        Row: {
          created_at: string;
          created_by: string;
          embedding_model: string;
          id: string;
          match_key: string | null;
          name: string;
          name_embedding: string | null;
          normalized_name: string;
          scope: unknown;
          type: string;
        };
        Insert: {
          created_at?: string;
          created_by?: string;
          embedding_model?: string;
          id?: string;
          match_key?: string | null;
          name: string;
          name_embedding?: string | null;
          normalized_name?: string;
          scope: unknown;
          type?: string;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          embedding_model?: string;
          id?: string;
          match_key?: string | null;
          name?: string;
          name_embedding?: string | null;
          normalized_name?: string;
          scope?: unknown;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'entities_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      eval_runs: {
        Row: {
          corpus_size: number;
          engine_version: string | null;
          harness: string;
          id: string;
          metrics: Json;
          run_at: string;
        };
        Insert: {
          corpus_size: number;
          engine_version?: string | null;
          harness: string;
          id?: string;
          metrics: Json;
          run_at?: string;
        };
        Update: {
          corpus_size?: number;
          engine_version?: string | null;
          harness?: string;
          id?: string;
          metrics?: Json;
          run_at?: string;
        };
        Relationships: [];
      };
      fusion_config: {
        Row: {
          fts_leg_weight: number;
          pool_multiplier: number;
          rrf_k: number;
          similarity_band_ceiling: number;
          similarity_band_floor: number;
          similarity_boost_weight: number;
          single_row: boolean;
          updated_at: string;
          vector_leg_weight: number;
        };
        Insert: {
          fts_leg_weight?: number;
          pool_multiplier?: number;
          rrf_k?: number;
          similarity_band_ceiling?: number;
          similarity_band_floor?: number;
          similarity_boost_weight?: number;
          single_row?: boolean;
          updated_at?: string;
          vector_leg_weight?: number;
        };
        Update: {
          fts_leg_weight?: number;
          pool_multiplier?: number;
          rrf_k?: number;
          similarity_band_ceiling?: number;
          similarity_band_floor?: number;
          similarity_boost_weight?: number;
          single_row?: boolean;
          updated_at?: string;
          vector_leg_weight?: number;
        };
        Relationships: [];
      };
      ingest_log: {
        Row: {
          chunk_hash: string;
          client: string;
          conversation_id: string | null;
          memories_created: number;
          processed_at: string | null;
          received_at: string;
          user_id: string;
        };
        Insert: {
          chunk_hash: string;
          client: string;
          conversation_id?: string | null;
          memories_created?: number;
          processed_at?: string | null;
          received_at?: string;
          user_id?: string;
        };
        Update: {
          chunk_hash?: string;
          client?: string;
          conversation_id?: string | null;
          memories_created?: number;
          processed_at?: string | null;
          received_at?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'ingest_log_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      loop_closure_checks: {
        Row: {
          checked_at: string;
          last_evidence_id: string;
          loop_id: string;
        };
        Insert: {
          checked_at?: string;
          last_evidence_id: string;
          loop_id: string;
        };
        Update: {
          checked_at?: string;
          last_evidence_id?: string;
          loop_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'loop_closure_checks_last_evidence_id_fkey';
            columns: ['last_evidence_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'loop_closure_checks_loop_id_fkey';
            columns: ['loop_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memories: {
        Row: {
          agent_name: string | null;
          author_kind: string;
          content: string;
          content_lang: string | null;
          content_original: string | null;
          created_at: string | null;
          embedding: string | null;
          embedding_model: string;
          fts: unknown;
          id: string;
          invalidated_at: string | null;
          invalidated_by: string | null;
          invalidated_by_agent: string | null;
          invalidated_by_model: string | null;
          kind: string;
          owner_id: string;
          scope: unknown;
          shared_at: string | null;
          shared_by: string | null;
          source: Json | null;
          superseded_by: string | null;
          translation_attempts: number;
          translation_error: string | null;
          translation_status: string;
          valid_from: string | null;
          visibility: string;
        };
        Insert: {
          agent_name?: string | null;
          author_kind?: string;
          content: string;
          content_lang?: string | null;
          content_original?: string | null;
          created_at?: string | null;
          embedding?: string | null;
          embedding_model?: string;
          fts?: unknown;
          id?: string;
          invalidated_at?: string | null;
          invalidated_by?: string | null;
          invalidated_by_agent?: string | null;
          invalidated_by_model?: string | null;
          kind?: string;
          owner_id?: string;
          scope: unknown;
          shared_at?: string | null;
          shared_by?: string | null;
          source?: Json | null;
          superseded_by?: string | null;
          translation_attempts?: number;
          translation_error?: string | null;
          translation_status?: string;
          valid_from?: string | null;
          visibility?: string;
        };
        Update: {
          agent_name?: string | null;
          author_kind?: string;
          content?: string;
          content_lang?: string | null;
          content_original?: string | null;
          created_at?: string | null;
          embedding?: string | null;
          embedding_model?: string;
          fts?: unknown;
          id?: string;
          invalidated_at?: string | null;
          invalidated_by?: string | null;
          invalidated_by_agent?: string | null;
          invalidated_by_model?: string | null;
          kind?: string;
          owner_id?: string;
          scope?: unknown;
          shared_at?: string | null;
          shared_by?: string | null;
          source?: Json | null;
          superseded_by?: string | null;
          translation_attempts?: number;
          translation_error?: string | null;
          translation_status?: string;
          valid_from?: string | null;
          visibility?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memories_invalidated_by_fkey';
            columns: ['invalidated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memories_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memories_shared_by_fkey';
            columns: ['shared_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memories_superseded_by_fkey';
            columns: ['superseded_by'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_chunks: {
        Row: {
          char_start: number;
          embedding: string;
          memory_id: string;
          ord: number;
        };
        Insert: {
          char_start?: number;
          embedding: string;
          memory_id: string;
          ord: number;
        };
        Update: {
          char_start?: number;
          embedding?: string;
          memory_id?: string;
          ord?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_chunks_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_entities: {
        Row: {
          created_at: string;
          entity_id: string;
          memory_id: string;
        };
        Insert: {
          created_at?: string;
          entity_id: string;
          memory_id: string;
        };
        Update: {
          created_at?: string;
          entity_id?: string;
          memory_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_entities_entity_id_fkey';
            columns: ['entity_id'];
            isOneToOne: false;
            referencedRelation: 'entities';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_entities_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_judge_checks: {
        Row: {
          checked_at: string;
          judge_model: string;
          memory_id: string;
        };
        Insert: {
          checked_at?: string;
          judge_model: string;
          memory_id: string;
        };
        Update: {
          checked_at?: string;
          judge_model?: string;
          memory_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_judge_checks_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_links: {
        Row: {
          created_at: string;
          dst: string;
          src: string;
          type: string;
        };
        Insert: {
          created_at?: string;
          dst: string;
          src: string;
          type?: string;
        };
        Update: {
          created_at?: string;
          dst?: string;
          src?: string;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_links_dst_fkey';
            columns: ['dst'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_links_src_fkey';
            columns: ['src'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_reinforcement: {
        Row: {
          last_used_at: string | null;
          memory_id: string;
          multiplier: number;
          updated_at: string;
          useful_events: number;
        };
        Insert: {
          last_used_at?: string | null;
          memory_id: string;
          multiplier: number;
          updated_at?: string;
          useful_events?: number;
        };
        Update: {
          last_used_at?: string | null;
          memory_id?: string;
          multiplier?: number;
          updated_at?: string;
          useful_events?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_reinforcement_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_review_queue: {
        Row: {
          confidence: number | null;
          created_at: string;
          id: string;
          memory_a: string;
          memory_b: string | null;
          rationale: string | null;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          similarity: number | null;
          status: string;
          verdict: string;
          winner: string | null;
        };
        Insert: {
          confidence?: number | null;
          created_at?: string;
          id?: string;
          memory_a: string;
          memory_b?: string | null;
          rationale?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          similarity?: number | null;
          status?: string;
          verdict: string;
          winner?: string | null;
        };
        Update: {
          confidence?: number | null;
          created_at?: string;
          id?: string;
          memory_a?: string;
          memory_b?: string | null;
          rationale?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          similarity?: number | null;
          status?: string;
          verdict?: string;
          winner?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_review_queue_memory_a_fkey';
            columns: ['memory_a'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_review_queue_memory_b_fkey';
            columns: ['memory_b'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_review_queue_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'memory_review_queue_winner_fkey';
            columns: ['winner'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      memory_verification: {
        Row: {
          checks: number;
          last_verified_at: string;
          memory_id: string;
          updated_at: string;
          verdict: string;
          verified_by_model: string | null;
        };
        Insert: {
          checks?: number;
          last_verified_at?: string;
          memory_id: string;
          updated_at?: string;
          verdict: string;
          verified_by_model?: string | null;
        };
        Update: {
          checks?: number;
          last_verified_at?: string;
          memory_id?: string;
          updated_at?: string;
          verdict?: string;
          verified_by_model?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'memory_verification_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      oauth_clients: {
        Row: {
          client_id: string;
          client_name: string | null;
          created_at: string;
          redirect_uris: string[];
          token_endpoint_auth_method: string;
        };
        Insert: {
          client_id?: string;
          client_name?: string | null;
          created_at?: string;
          redirect_uris: string[];
          token_endpoint_auth_method?: string;
        };
        Update: {
          client_id?: string;
          client_name?: string | null;
          created_at?: string;
          redirect_uris?: string[];
          token_endpoint_auth_method?: string;
        };
        Relationships: [];
      };
      oauth_codes: {
        Row: {
          access_token: string;
          client_id: string;
          code: string;
          code_challenge: string;
          created_at: string;
          expires_at: string;
          redirect_uri: string;
          refresh_token: string;
          resource: string | null;
          used_at: string | null;
          user_id: string;
        };
        Insert: {
          access_token: string;
          client_id: string;
          code: string;
          code_challenge: string;
          created_at?: string;
          expires_at: string;
          redirect_uri: string;
          refresh_token: string;
          resource?: string | null;
          used_at?: string | null;
          user_id: string;
        };
        Update: {
          access_token?: string;
          client_id?: string;
          code?: string;
          code_challenge?: string;
          created_at?: string;
          expires_at?: string;
          redirect_uri?: string;
          refresh_token?: string;
          resource?: string | null;
          used_at?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'oauth_codes_client_id_fkey';
            columns: ['client_id'];
            isOneToOne: false;
            referencedRelation: 'oauth_clients';
            referencedColumns: ['client_id'];
          },
          {
            foreignKeyName: 'oauth_codes_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      policy_allowances: {
        Row: {
          budget_id: string;
          limit_value: number | null;
          subject_id: string;
          updated_at: string;
          window_days: number | null;
        };
        Insert: {
          budget_id: string;
          limit_value?: number | null;
          subject_id: string;
          updated_at?: string;
          window_days?: number | null;
        };
        Update: {
          budget_id?: string;
          limit_value?: number | null;
          subject_id?: string;
          updated_at?: string;
          window_days?: number | null;
        };
        Relationships: [];
      };
      portability_candidates: {
        Row: {
          created_at: string;
          from_scope: unknown;
          id: string;
          judge_confidence: number | null;
          judge_model: string | null;
          judge_rationale: string | null;
          memory_id: string;
          owner_id: string;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          status: string;
          to_scope: unknown;
        };
        Insert: {
          created_at?: string;
          from_scope: unknown;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          memory_id: string;
          owner_id: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          to_scope: unknown;
        };
        Update: {
          created_at?: string;
          from_scope?: unknown;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          memory_id?: string;
          owner_id?: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          status?: string;
          to_scope?: unknown;
        };
        Relationships: [
          {
            foreignKeyName: 'portability_candidates_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'portability_candidates_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'portability_candidates_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          created_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      project_bindings: {
        Row: {
          created_at: string;
          created_by: string;
          id: string;
          match_key: string;
          match_kind: string;
          scope: unknown;
        };
        Insert: {
          created_at?: string;
          created_by?: string;
          id?: string;
          match_key: string;
          match_kind: string;
          scope: unknown;
        };
        Update: {
          created_at?: string;
          created_by?: string;
          id?: string;
          match_key?: string;
          match_kind?: string;
          scope?: unknown;
        };
        Relationships: [
          {
            foreignKeyName: 'project_bindings_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      provider_credentials: {
        Row: {
          base_url: string | null;
          created_at: string;
          hint: string;
          model: string | null;
          provider: string;
          secret_id: string;
          subject_id: string;
          updated_at: string;
        };
        Insert: {
          base_url?: string | null;
          created_at?: string;
          hint: string;
          model?: string | null;
          provider: string;
          secret_id: string;
          subject_id: string;
          updated_at?: string;
        };
        Update: {
          base_url?: string | null;
          created_at?: string;
          hint?: string;
          model?: string | null;
          provider?: string;
          secret_id?: string;
          subject_id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      ranking_config: {
        Row: {
          half_life_days: number;
          kind: string;
          updated_at: string;
          weight: number;
        };
        Insert: {
          half_life_days: number;
          kind: string;
          updated_at?: string;
          weight: number;
        };
        Update: {
          half_life_days?: number;
          kind?: string;
          updated_at?: string;
          weight?: number;
        };
        Relationships: [];
      };
      reflection_candidate_members: {
        Row: {
          candidate_id: string;
          memory_id: string;
          ord: number;
        };
        Insert: {
          candidate_id: string;
          memory_id: string;
          ord: number;
        };
        Update: {
          candidate_id?: string;
          memory_id?: string;
          ord?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'reflection_candidate_members_candidate_id_fkey';
            columns: ['candidate_id'];
            isOneToOne: false;
            referencedRelation: 'reflection_candidates';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reflection_candidate_members_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      reflection_candidates: {
        Row: {
          approved_memory_id: string | null;
          created_at: string;
          distilled_content: string | null;
          distilled_kind: string | null;
          id: string;
          judge_confidence: number | null;
          judge_model: string | null;
          judge_rationale: string | null;
          owner_id: string;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          scope: unknown;
          snoozed_until: string | null;
          status: string;
        };
        Insert: {
          approved_memory_id?: string | null;
          created_at?: string;
          distilled_content?: string | null;
          distilled_kind?: string | null;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          owner_id: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          scope: unknown;
          snoozed_until?: string | null;
          status?: string;
        };
        Update: {
          approved_memory_id?: string | null;
          created_at?: string;
          distilled_content?: string | null;
          distilled_kind?: string | null;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          owner_id?: string;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          scope?: unknown;
          snoozed_until?: string | null;
          status?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'reflection_candidates_approved_memory_id_fkey';
            columns: ['approved_memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reflection_candidates_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'reflection_candidates_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      roi_probes: {
        Row: {
          created_at: string;
          id: string;
          owner_id: string;
          question: string;
          retired_at: string | null;
          source_memory_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          owner_id: string;
          question: string;
          retired_at?: string | null;
          source_memory_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          owner_id?: string;
          question?: string;
          retired_at?: string | null;
          source_memory_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'roi_probes_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'roi_probes_source_memory_id_fkey';
            columns: ['source_memory_id'];
            isOneToOne: false;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
        ];
      };
      roi_results: {
        Row: {
          confidence: number;
          id: string;
          model: string | null;
          owner_id: string;
          probe_id: string;
          run_at: string;
          run_id: string;
          with_memory: boolean;
          without_memory: boolean;
        };
        Insert: {
          confidence?: number;
          id?: string;
          model?: string | null;
          owner_id: string;
          probe_id: string;
          run_at?: string;
          run_id: string;
          with_memory: boolean;
          without_memory: boolean;
        };
        Update: {
          confidence?: number;
          id?: string;
          model?: string | null;
          owner_id?: string;
          probe_id?: string;
          run_at?: string;
          run_id?: string;
          with_memory?: boolean;
          without_memory?: boolean;
        };
        Relationships: [
          {
            foreignKeyName: 'roi_results_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'roi_results_probe_id_fkey';
            columns: ['probe_id'];
            isOneToOne: false;
            referencedRelation: 'roi_probes';
            referencedColumns: ['id'];
          },
        ];
      };
      rule_candidates: {
        Row: {
          applies_scope: unknown;
          created_at: string;
          first_used_at: string | null;
          id: string;
          judge_confidence: number | null;
          judge_model: string | null;
          judge_rationale: string | null;
          last_used_at: string | null;
          memory_id: string;
          pinned: boolean;
          promoted_at: string | null;
          resolution: string | null;
          resolved_at: string | null;
          resolved_by: string | null;
          revoke_reason: string | null;
          revoked_at: string | null;
          rule_text: string | null;
          session_keys: Json | null;
          snoozed_until: string | null;
          status: string;
          suggested_scopes: Json | null;
          target_layer: string | null;
          useful_sessions: number;
          window_days: number;
        };
        Insert: {
          applies_scope?: unknown;
          created_at?: string;
          first_used_at?: string | null;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          last_used_at?: string | null;
          memory_id: string;
          pinned?: boolean;
          promoted_at?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          rule_text?: string | null;
          session_keys?: Json | null;
          snoozed_until?: string | null;
          status?: string;
          suggested_scopes?: Json | null;
          target_layer?: string | null;
          useful_sessions: number;
          window_days: number;
        };
        Update: {
          applies_scope?: unknown;
          created_at?: string;
          first_used_at?: string | null;
          id?: string;
          judge_confidence?: number | null;
          judge_model?: string | null;
          judge_rationale?: string | null;
          last_used_at?: string | null;
          memory_id?: string;
          pinned?: boolean;
          promoted_at?: string | null;
          resolution?: string | null;
          resolved_at?: string | null;
          resolved_by?: string | null;
          revoke_reason?: string | null;
          revoked_at?: string | null;
          rule_text?: string | null;
          session_keys?: Json | null;
          snoozed_until?: string | null;
          status?: string;
          suggested_scopes?: Json | null;
          target_layer?: string | null;
          useful_sessions?: number;
          window_days?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'rule_candidates_memory_id_fkey';
            columns: ['memory_id'];
            isOneToOne: true;
            referencedRelation: 'memories';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'rule_candidates_resolved_by_fkey';
            columns: ['resolved_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      scope_members: {
        Row: {
          accepted_at: string | null;
          created_at: string;
          granted_by: string | null;
          invited_email: string | null;
          role: string;
          scope: unknown;
          user_id: string;
        };
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          granted_by?: string | null;
          invited_email?: string | null;
          role: string;
          scope: unknown;
          user_id: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          granted_by?: string | null;
          invited_email?: string | null;
          role?: string;
          scope?: unknown;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scope_members_granted_by_fkey';
            columns: ['granted_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'scope_members_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      scopes: {
        Row: {
          alias: string | null;
          created_at: string;
          created_by: string;
          description: string | null;
          description_source: string | null;
          scope: unknown;
          updated_at: string;
        };
        Insert: {
          alias?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          description_source?: string | null;
          scope: unknown;
          updated_at?: string;
        };
        Update: {
          alias?: string | null;
          created_at?: string;
          created_by?: string;
          description?: string | null;
          description_source?: string | null;
          scope?: unknown;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'scopes_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      session_threads: {
        Row: {
          conversation_id: string;
          created_at: string;
          expires_at: string;
          id: string;
          last_seen_at: string;
          owner_id: string;
          scope_path: unknown;
        };
        Insert: {
          conversation_id: string;
          created_at?: string;
          expires_at?: string;
          id?: string;
          last_seen_at?: string;
          owner_id: string;
          scope_path: unknown;
        };
        Update: {
          conversation_id?: string;
          created_at?: string;
          expires_at?: string;
          id?: string;
          last_seen_at?: string;
          owner_id?: string;
          scope_path?: unknown;
        };
        Relationships: [
          {
            foreignKeyName: 'session_threads_owner_id_fkey';
            columns: ['owner_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      usage_daily: {
        Row: {
          briefing_hits: number;
          briefing_total: number;
          captured: number;
          day: string;
          judged: number;
          recall_calls: number;
          relevant: number;
          rolled_up_at: string;
          saved_tokens: number;
          used: number;
          user_id: string;
          write_tokens: number;
        };
        Insert: {
          briefing_hits?: number;
          briefing_total?: number;
          captured?: number;
          day: string;
          judged?: number;
          recall_calls?: number;
          relevant?: number;
          rolled_up_at?: string;
          saved_tokens?: number;
          used?: number;
          user_id: string;
          write_tokens?: number;
        };
        Update: {
          briefing_hits?: number;
          briefing_total?: number;
          captured?: number;
          day?: string;
          judged?: number;
          recall_calls?: number;
          relevant?: number;
          rolled_up_at?: string;
          saved_tokens?: number;
          used?: number;
          user_id?: string;
          write_tokens?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'usage_daily_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      usage_events: {
        Row: {
          agent_name: string | null;
          event_type: string;
          id: string;
          metadata: Json | null;
          occurred_at: string;
          quantity: number;
          request_id: string | null;
          unit: string;
          user_id: string | null;
        };
        Insert: {
          agent_name?: string | null;
          event_type: string;
          id?: string;
          metadata?: Json | null;
          occurred_at?: string;
          quantity?: number;
          request_id?: string | null;
          unit?: string;
          user_id?: string | null;
        };
        Update: {
          agent_name?: string | null;
          event_type?: string;
          id?: string;
          metadata?: Json | null;
          occurred_at?: string;
          quantity?: number;
          request_id?: string | null;
          unit?: string;
          user_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'usage_events_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_scope_invitation: {
        Args: { p_scope: unknown };
        Returns: undefined;
      };
      add_scope_member: {
        Args: { p_role: string; p_scope: unknown; p_user: string };
        Returns: undefined;
      };
      build_context: {
        Args: {
          briefing?: boolean;
          max_entities?: number;
          max_memories?: number;
          scope_filter?: unknown[];
          topic_embedding: string;
          topic_text: string;
        };
        Returns: Json;
      };
      can_write_scope: { Args: { p_scope: unknown }; Returns: boolean };
      create_scope: { Args: { p_scope: unknown }; Returns: undefined };
      dashboard_activity: {
        Args: {
          p_days?: number;
          p_limit?: number;
          p_offset?: number;
          p_outcome?: string;
        };
        Returns: Json;
      };
      dashboard_metrics: { Args: { p_days?: number }; Returns: Json };
      dashboard_metrics_series: { Args: { p_days?: number }; Returns: Json };
      dashboard_roi: { Args: never; Returns: Json };
      decline_scope_invitation: {
        Args: { p_scope: unknown };
        Returns: undefined;
      };
      delete_scope: { Args: { p_scope: unknown }; Returns: Json };
      entity_id_crockford_alphabet: { Args: never; Returns: string };
      entity_id_crockford_from_bits: {
        Args: { bits: unknown };
        Returns: string;
      };
      entity_id_encode_rand_16: { Args: { bytes: string }; Returns: string };
      entity_id_encode_ts_10: { Args: { ms: number }; Returns: string };
      entity_id_generate: { Args: { prefix: string }; Returns: string };
      feed_facet_counts: {
        Args: {
          p_id_prefix?: string;
          p_kind?: string;
          p_q?: string;
          p_scope?: string;
          p_status?: string;
          p_visibility?: string;
        };
        Returns: {
          facet: string;
          total: number;
          value: string;
        }[];
      };
      find_authoritative_coverage: {
        Args: { min_similarity?: number; query_embedding: string };
        Returns: {
          content: string;
          id: string;
          similarity: number;
        }[];
      };
      find_content_anchors: {
        Args: {
          content_text: string;
          min_name_length?: number;
          p_limit?: number;
          scope_filter: unknown;
        };
        Returns: {
          id: string;
          name: string;
          type: string;
        }[];
      };
      find_judge_rescan_candidates: {
        Args: {
          p_judge_model: string;
          p_limit?: number;
          p_min_surfacings?: number;
          p_owner?: string;
          p_window_days?: number;
        };
        Returns: {
          last_surfaced_at: string;
          memory_id: string;
          owner_id: string;
          surfacings: number;
        }[];
      };
      find_loop_closure_evidence: {
        Args: {
          p_max_evidence?: number;
          p_min_similarity?: number;
          p_owner?: string;
        };
        Returns: {
          evidence_ids: string[];
          loop_id: string;
          newest_evidence_id: string;
          owner_id: string;
          top_similarity: number;
        }[];
      };
      find_portability_candidates: {
        Args: { p_limit?: number; p_owner?: string };
        Returns: {
          content: string;
          kind: string;
          memory_id: string;
          multiplier: number;
          owner_id: string;
          scope: string;
        }[];
      };
      find_reflection_clusters: {
        Args: {
          p_max_members?: number;
          p_max_similarity?: number;
          p_min_similarity?: number;
          p_min_size?: number;
          p_owner?: string;
        };
        Returns: {
          cluster_key: string;
          memory_ids: string[];
          owner_id: string;
          scope: string;
        }[];
      };
      find_reinforcement_signals: {
        Args: { p_window_days?: number };
        Returns: {
          in_band_events: number;
          judge_confidence: number;
          last_used_at: string;
          memory_id: string;
          misled_confidence: number;
          misled_events: number;
          owner_id: string;
          promoted: boolean;
        }[];
      };
      find_reverify_candidates: {
        Args: {
          p_limit?: number;
          p_ttl_fact_days?: number;
          p_ttl_reference_days?: number;
        };
        Returns: {
          age_days: number;
          content: string;
          kind: string;
          last_verified_at: string;
          memory_id: string;
          multiplier: number;
          owner_id: string;
        }[];
      };
      find_review_candidates: {
        Args: {
          p_limit?: number;
          p_memory_id: string;
          p_min_similarity?: number;
        };
        Returns: {
          agent_name: string;
          author_kind: string;
          content: string;
          created_at: string;
          id: string;
          kind: string;
          scope: string;
          similarity: number;
        }[];
      };
      find_rule_candidates: {
        Args: {
          p_min_sessions?: number;
          p_owner?: string;
          p_stability_days?: number;
          p_window_days?: number;
        };
        Returns: {
          content: string;
          first_used_at: string;
          kind: string;
          last_used_at: string;
          memory_id: string;
          owner_id: string;
          scope: string;
          session_keys: Json;
          useful_sessions: number;
        }[];
      };
      find_similar_entity: {
        Args: {
          entity_type?: string;
          query_embedding: string;
          scope_filter?: unknown;
          threshold?: number;
        };
        Returns: {
          id: string;
          name: string;
          similarity: number;
          type: string;
        }[];
      };
      find_similar_memory: {
        Args: {
          query_embedding: string;
          query_windows?: string[];
          scope_filter: unknown;
          threshold?: number;
          window_agreement?: number;
        };
        Returns: {
          agent_name: string;
          author_kind: string;
          content: string;
          id: string;
          similarity: number;
          source: Json;
        }[];
      };
      find_stale_suspects: {
        Args: { p_threshold?: number; p_window_days?: number };
        Returns: {
          last_misled_at: string;
          memory_id: string;
          misled_count: number;
          owner_id: string;
        }[];
      };
      find_supersede_candidates: {
        Args: {
          max_similarity?: number;
          min_similarity?: number;
          p_limit?: number;
          query_embedding: string;
        };
        Returns: {
          content: string;
          created_at: string;
          id: string;
          kind: string;
          scope: string;
          similarity: number;
          source: Json;
        }[];
      };
      hard_delete_user: { Args: { p_user_id: string }; Returns: Json };
      instance_metrics: { Args: { p_days?: number }; Returns: Json };
      instance_metrics_series: { Args: { p_days?: number }; Returns: Json };
      invite_scope_member: {
        Args: { p_email: string; p_role: string; p_scope: unknown };
        Returns: string;
      };
      is_entity_id: { Args: { value: string }; Returns: boolean };
      is_entity_id_with_prefix: {
        Args: { prefix: string; value: string };
        Returns: boolean;
      };
      list_memory_scopes: {
        Args: never;
        Returns: {
          alias: string;
          scope: string;
        }[];
      };
      memory_version_history: {
        Args: { p_id: string };
        Returns: {
          content: string;
          created_at: string;
          id: string;
          invalidated_at: string;
          is_current: boolean;
          kind: string;
          superseded_by: string;
        }[];
      };
      merge_entities: {
        Args: { p_canonical: string; p_duplicates: string[]; p_type?: string };
        Returns: Json;
      };
      merge_scopes: {
        Args: { p_from: unknown; p_into: unknown };
        Returns: Json;
      };
      pending_scope_invitations: {
        Args: never;
        Returns: {
          granted_at: string;
          role: string;
          scope: unknown;
        }[];
      };
      policy_period: {
        Args: { p_subject_id: string };
        Returns: {
          ends_at: string;
          starts_at: string;
        }[];
      };
      policy_spend: {
        Args: {
          p_budget_id: string;
          p_subject_id?: string;
          p_window_days: number;
        };
        Returns: number;
      };
      promote_memory_to_rule: {
        Args: {
          p_applies_scope?: unknown;
          p_force?: boolean;
          p_memory_id: string;
        };
        Returns: {
          applies_scope: string;
          candidate_id: string;
          rule_text: string;
          status: string;
          target_layer: string;
        }[];
      };
      provider_credential_for: {
        Args: { p_subject_id: string };
        Returns: {
          api_key: string;
          base_url: string;
          model: string;
          provider: string;
        }[];
      };
      rename_scope: {
        Args: { p_new_slug: string; p_scope: unknown };
        Returns: string;
      };
      resolve_portability_candidate: {
        Args: { p_approve: boolean; p_candidate_id: string };
        Returns: {
          candidate_id: string;
          from_scope: string;
          memory_id: string;
          status: string;
          to_scope: string;
        }[];
      };
      resolve_scope_member_candidate: {
        Args: { p_email: string; p_scope: unknown };
        Returns: string;
      };
      revoke_provider_credential: {
        Args: { p_subject_id: string };
        Returns: undefined;
      };
      rule_candidate_scopes: {
        Args: never;
        Returns: {
          candidate_count: number;
          scope: string;
        }[];
      };
      scope_member_identities: {
        Args: never;
        Returns: {
          display_name: string;
          email: string;
          user_id: string;
        }[];
      };
      search_memories: {
        Args: {
          k?: number;
          kinds?: string[];
          query_embedding: string;
          query_text: string;
          scope_filter?: unknown[];
        };
        Returns: {
          content: string;
          created_at: string;
          dispute_id: string;
          dispute_with: string;
          disputed: boolean;
          fts_matched: boolean;
          id: string;
          kind: string;
          scope: string;
          score: number;
          similarity: number;
          visibility: string;
        }[];
      };
      session_receipt: { Args: { p_since: string }; Returns: Json };
      set_provider_credential: {
        Args: {
          p_api_key: string;
          p_base_url?: string;
          p_model?: string;
          p_provider: string;
          p_subject_id: string;
        };
        Returns: undefined;
      };
      traverse_entities: {
        Args: {
          edge_types?: string[];
          max_depth?: number;
          start_entity: string;
        };
        Returns: {
          depth: number;
          entity_id: string;
          name: string;
          path: string[];
          type: string;
          via_edge_type: string;
        }[];
      };
      usage_daily_rollup: { Args: { p_days?: number }; Returns: number };
      usage_events_ensure_partitions: {
        Args: { p_months_ahead?: number };
        Returns: number;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  'public'
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
