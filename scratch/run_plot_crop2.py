
import math
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.tri as tri

with open('/Users/paulwilliams/Documents/Programming/CAUCSim/scratch/extracted-results/postProcessing/cutPlane/50/yNormal.vtk', 'r') as f:
    content = f.read()

tokens = content.split()
idx = 0
points = []
u_data = []

while idx < len(tokens):
    token = tokens[idx]
    if token == 'POINTS':
        num_points = int(tokens[idx+1])
        idx += 3
        for _ in range(num_points):
            points.append((float(tokens[idx]), float(tokens[idx+1]), float(tokens[idx+2])))
            idx += 3
        continue
    if token == 'FIELD':
        num_fields = int(tokens[idx+2])
        idx += 3
        for _ in range(num_fields):
            field_name = tokens[idx]
            num_comp = int(tokens[idx+1])
            num_tuples = int(tokens[idx+2])
            idx += 4
            
            field_vals = []
            total_vals = num_tuples * num_comp
            for _ in range(total_vals):
                field_vals.append(float(tokens[idx]))
                idx += 1
            if field_name == 'U' and num_comp == 3:
                for k in range(0, len(field_vals), 3):
                    u_data.append((field_vals[k], field_vals[k+1], field_vals[k+2]))
        continue
    idx += 1

x_coords = [p[0] for p in points]
z_coords = [p[2] for p in points]
u_mag = [math.sqrt(u[0]**2 + u[1]**2 + u[2]**2) for u in u_data]

plt.figure(figsize=(12, 3.8), facecolor='#0b0f19')
ax = plt.axes()
ax.set_facecolor('#070a13')

triang = tri.Triangulation(x_coords, z_coords)
contour = plt.tricontourf(triang, u_mag, levels=50, cmap='turbo', vmin=0, vmax=30)

cb = plt.colorbar(contour, ax=ax, orientation='horizontal', pad=0.25, aspect=50)
cb.set_label('Velocity Magnitude (m/s)', color='#93c5fd', fontsize=10)
cb.ax.xaxis.set_tick_params(color='#93c5fd', labelcolor='#93c5fd')
cb.outline.set_edgecolor('#1e293b')

plt.title('Centerline Velocity Slice (Y = 0 Plane)', color='#f8fafc', fontsize=12, pad=12)
plt.xlabel('X (m)', color='#94a3b8')
plt.ylabel('Z (m)', color='#94a3b8')
ax.tick_params(colors='#64748b')
for spine in ax.spines.values():
    spine.set_edgecolor('#1e293b')

ax.set_xlim(-1.0, 9.0)
ax.set_ylim(0.0, 2.0)
ax.set_aspect('equal', adjustable='box')

plt.tight_layout()
plt.savefig('/Users/paulwilliams/Documents/Programming/CAUCSim/scratch/flow_slice_crop_2.png', dpi=150, facecolor='#0b0f19')
plt.close()
print("SUCCESS: Generated cropped 2 slice image!")
