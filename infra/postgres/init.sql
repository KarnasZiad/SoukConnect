-- Local development only: one role and one database per service, development passwords.
-- In Kubernetes, each service receives its own credentials from a Secret.

CREATE ROLE gateway LOGIN PASSWORD 'gateway';
CREATE DATABASE gateway OWNER gateway;

CREATE ROLE orders LOGIN PASSWORD 'orders';
CREATE DATABASE orders OWNER orders;

CREATE ROLE payments LOGIN PASSWORD 'payments';
CREATE DATABASE payments OWNER payments;

-- No role but the owner may connect to a service database.
REVOKE ALL ON DATABASE gateway FROM PUBLIC;
REVOKE ALL ON DATABASE orders FROM PUBLIC;
REVOKE ALL ON DATABASE payments FROM PUBLIC;
