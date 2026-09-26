CREATE POLICY profile_owner_read ON profiles FOR SELECT USING (id = current_user);
