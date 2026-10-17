# CorporateLLM test accounts

These accounts are seeded for local CorporateLLM testing against the `dev-moritz-diesing` Supabase branch.
Reuse these accounts across sessions instead of creating separate test accounts.

The unnumbered address owns its team.
Addresses numbered 2 through 5 are regular members of the matching Starter, Pro, or Max team.
The numbered members use the standard test-seed password.

`max@example.com` is the only platform administrator among these test users.
`pro@example.com` is an active partner; all five Starter users are attributed to this partner, and the Starter team is assigned to it.
These partner and referral fixtures are stored in the developer database without an external Rewardful registration.
Admin and partner console access requires MFA in addition to password login.

| Plan    | Email                | Teamgröße | IstPartner | IstGeworben | GeworbenVon     | IstAdmin | AnmeldeMethode |
| ------- | -------------------- | --------- | ---------- | ----------- | --------------- | -------- | -------------- |
| Free    | free@example.com     | 1         | false      | false       | -               | false    | Passwort       |
| Starter | starter@example.com  | 5         | false      | true        | pro@example.com | false    | Passwort       |
| Starter | starter2@example.com | 5         | false      | true        | pro@example.com | false    | Passwort       |
| Starter | starter3@example.com | 5         | false      | true        | pro@example.com | false    | Passwort       |
| Starter | starter4@example.com | 5         | false      | true        | pro@example.com | false    | Passwort       |
| Starter | starter5@example.com | 5         | false      | true        | pro@example.com | false    | Passwort       |
| Pro     | pro@example.com      | 5         | true       | false       | -               | false    | Passwort       |
| Pro     | pro2@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Pro     | pro3@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Pro     | pro4@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Pro     | pro5@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Max     | max@example.com      | 5         | false      | false       | -               | true     | Passwort       |
| Max     | max2@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Max     | max3@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Max     | max4@example.com     | 5         | false      | false       | -               | false    | Passwort       |
| Max     | max5@example.com     | 5         | false      | false       | -               | false    | Passwort       |
