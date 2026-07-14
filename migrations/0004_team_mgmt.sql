UPDATE teams
SET repo_full_name = 'cogworks-demo/vector-voyagers',
    repo_name = 'vector-voyagers',
    repo_url = 'https://github.com/cogworks-demo/vector-voyagers'
WHERE id = 'team_demo';

DELETE FROM team_members WHERE team_id = 'team_demo';
