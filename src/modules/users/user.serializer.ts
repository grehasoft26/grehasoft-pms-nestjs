export function formatUserResponse(user: any) {
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    role: user.role_id || (user.role ? user.role.id : null),
    role_name: user.role ? user.role.name : '',
    role_permissions: user.role && user.role.permissions ? user.role.permissions : [],
    department: user.department_id || (user.department ? user.department.id : null),
    department_name: user.department ? user.department.name : null,
    status: user.status || 'active',
    is_active: user.is_active !== undefined ? user.is_active : true,
    date_joined: user.created_at ? user.created_at.toISOString() : null,
    last_login: user.last_login ? user.last_login.toISOString() : null,
    position: user.position || null,
    joining_date: user.joining_date ? user.joining_date.toISOString().split('T')[0] : null,
    salary_monthly: user.salary_monthly ? String(user.salary_monthly) : null,
    address: user.address || null,
    is_superuser: user.is_superuser || false,
    client: user.client_id || (user.client ? user.client.id : null),
    client_name: user.client ? user.client.name : null,
    company_name: user.client ? user.client.company_name : null,
    profile_photo: user.profile_photo || null,
  };
}
