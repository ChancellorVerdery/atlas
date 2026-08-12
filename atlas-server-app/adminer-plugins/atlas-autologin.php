<?php
/** Sign the console's Database tab in automatically.
 *
 * The tab already sits behind the SSH-key gate and the console's basic auth, so
 * a third prompt for the Postgres password bought nothing — it only meant
 * keeping a database password to hand to look at a table.
 *
 * SAFE ONLY BEHIND THOSE LAYERS. Anything that can reach Adminer now has full
 * database access with no password at all. Adminer is published on
 * 127.0.0.1:8082 only and served solely as /db on the console; do not expose it
 * by any other route.
 *
 * Credentials come from the environment (see the adminer service in
 * compose.yml, fed by the same .env that supplies POSTGRES_PASSWORD). They are
 * deliberately not written in this file, which is in git.
 *
 * index.php requires this from inside `namespace docker`, so the base class has
 * to be fully qualified, and the file must return an instance rather than just
 * declare one.
 */
class AdminerAtlasAutoLogin extends \Adminer\Plugin
{
    public function credentials()
    {
        return array(
            getenv('ATLAS_DB_HOST') ?: 'postgres',
            getenv('ATLAS_DB_USER') ?: 'postgres',
            getenv('ATLAS_DB_PASS'),
        );
    }

    /** Authorise whatever the login form (or the console's link) submitted:
     * credentials() above decides what actually reaches Postgres, so there is
     * nothing here for a caller to influence. */
    public function login($login, $password)
    {
        return true;
    }
}

return new AdminerAtlasAutoLogin();
