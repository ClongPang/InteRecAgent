ALTER TABLE interec_agent.turn_input_messages
  DROP CONSTRAINT turn_input_messages_message_id_fkey;

ALTER TABLE interec_agent.turn_input_messages
  ADD CONSTRAINT turn_input_messages_message_id_fkey
  FOREIGN KEY (message_id) REFERENCES interec_agent.messages(id) ON DELETE CASCADE;
