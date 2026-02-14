class NetworkStatusIcon:
    def __init__(self, status_font_size):
        self.status_font_size = status_font_size
        self.icon_width = 18
        self.icon_height = 15
        self.line_width = 2
        self.outline_color = "white"

    def measure(self):
        return (self.icon_width, self.icon_height)

    def get_top_y(self):
        return self.status_font_size // 2

    def render(self, draw, x, y):
        center_x = x + self.icon_width // 2
        bottom_y = y + self.icon_height - 1

        # Base dot
        dot_radius = 1
        draw.ellipse((center_x - dot_radius, bottom_y - dot_radius,
                      center_x + dot_radius, bottom_y + dot_radius),
                     fill=self.outline_color)

        # Wi-Fi arcs
        arc1_box = (center_x - 4, bottom_y - 7, center_x + 4, bottom_y + 1)
        arc2_box = (center_x - 7, bottom_y - 10, center_x + 7, bottom_y + 4)
        draw.arc(arc1_box, 210, 330, fill=self.outline_color, width=self.line_width)
        draw.arc(arc2_box, 210, 330, fill=self.outline_color, width=self.line_width)
