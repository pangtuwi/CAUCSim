import sys
import os
import math
import matplotlib
matplotlib.use('Agg') # Offscreen rendering
import matplotlib.pyplot as plt
import matplotlib.tri as tri

def main():
    if len(sys.argv) < 3:
        print("Usage: generate_slice.py <vtk_file> <output_png>")
        sys.exit(1)
        
    vtk_path = sys.argv[1]
    out_path = sys.argv[2]
    
    if not os.path.exists(vtk_path):
        print(f"Error: {vtk_path} does not exist")
        sys.exit(1)
        
    with open(vtk_path, 'r') as f:
        content = f.read()
        
    # Tokenize the entire file contents
    tokens = content.split()
    if not tokens:
        print("Error: VTK file is empty")
        sys.exit(1)
        
    idx = 0
    points = []
    u_data = []
    
    while idx < len(tokens):
        token = tokens[idx]
        if token == 'POINTS':
            num_points = int(tokens[idx+1])
            # Skip POINTS, count, and type (e.g. float)
            idx += 3
            for _ in range(num_points):
                if idx + 2 >= len(tokens):
                    print("Error: Premature end of tokens while parsing POINTS")
                    sys.exit(1)
                x = float(tokens[idx])
                y = float(tokens[idx+1])
                z = float(tokens[idx+2])
                points.append((x, y, z))
                idx += 3
            continue
            
        if token == 'FIELD':
            # FIELD attributes 2
            num_fields = int(tokens[idx+2])
            idx += 3
            for _ in range(num_fields):
                if idx + 3 >= len(tokens):
                    break
                field_name = tokens[idx]
                num_comp = int(tokens[idx+1])
                num_tuples = int(tokens[idx+2])
                # Skip field_name, num_comp, num_tuples, type
                idx += 4
                
                field_vals = []
                total_vals = num_tuples * num_comp
                for _ in range(total_vals):
                    if idx >= len(tokens):
                        print(f"Error: Premature end of tokens while parsing FIELD {field_name}")
                        sys.exit(1)
                    field_vals.append(float(tokens[idx]))
                    idx += 1
                    
                if field_name == 'U' and num_comp == 3:
                    for k in range(0, len(field_vals), 3):
                        u_data.append((field_vals[k], field_vals[k+1], field_vals[k+2]))
            continue
            
        idx += 1
        
    if not points:
        print("Error: No points found in VTK file")
        sys.exit(1)
    if not u_data:
        print("Error: No velocity (U) field data found in VTK file")
        sys.exit(1)
        
    # Project points on X-Z plane (centerline is Y = 0)
    x_coords = [p[0] for p in points]
    z_coords = [p[2] for p in points]
    
    # Calculate velocity magnitude
    u_mag = [math.sqrt(u[0]**2 + u[1]**2 + u[2]**2) for u in u_data]
    
    # Create plot
    plt.figure(figsize=(12, 3.8), facecolor='#0b0f19') # Sleek dark background matching CAUCSim UI
    ax = plt.axes()
    ax.set_facecolor('#070a13')
    
    # Create triangulation
    triang = tri.Triangulation(x_coords, z_coords)
    
    # Generate filled contours (rainbow/turbo colormap)
    contour = plt.tricontourf(triang, u_mag, levels=50, cmap='turbo', vmin=0, vmax=30)
    
    # Add colorbar
    cb = plt.colorbar(contour, ax=ax, orientation='horizontal', pad=0.25, aspect=50)
    cb.set_label('Velocity Magnitude (m/s)', color='#93c5fd', fontsize=10)
    cb.ax.xaxis.set_tick_params(color='#93c5fd', labelcolor='#93c5fd')
    cb.outline.set_edgecolor('#1e293b')
    
    # Plot style
    plt.title('Centerline Velocity Slice (Y = 0 Plane)', color='#f8fafc', fontsize=12, pad=12)
    plt.xlabel('X (m)', color='#94a3b8')
    plt.ylabel('Z (m)', color='#94a3b8')
    ax.tick_params(colors='#64748b')
    for spine in ax.spines.values():
        spine.set_edgecolor('#1e293b')
        
    # Crop view to domain boundaries containing the car
    ax.set_xlim(-1.0, 9.0)
    ax.set_ylim(0.0, 2.0)
    ax.set_aspect('equal', adjustable='box')
    
    plt.tight_layout()
    plt.savefig(out_path, dpi=150, facecolor='#0b0f19')
    plt.close()
    print("Successfully generated flow slice image!")

if __name__ == '__main__':
    main()
